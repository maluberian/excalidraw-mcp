import { io, type Socket } from "socket.io-client";
import { getStorage, ref, uploadBytes } from "firebase/storage";
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { deflate } from "pako";

type FirestoreValue =
  | { integerValue: string }
  | { bytesValue: string };

type FirestoreDocument = {
  fields?: Record<string, FirestoreValue>;
};

type FirebaseConfig = {
  apiKey: string;
  appId?: string;
  authDomain?: string;
  databaseURL?: string;
  messagingSenderId?: string;
  projectId: string;
  storageBucket?: string;
};

type ExcalidrawElementLike = {
  id: string;
  isDeleted?: boolean;
  updated?: number;
  version?: number;
  versionNonce?: number;
  type?: string;
  fileId?: string;
  status?: string;
  [key: string]: unknown;
};

type BinaryFileLike = {
  id?: string;
  mimeType?: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
  version?: number;
};

type ParsedRoom = {
  roomId: string;
  roomKey: string;
  roomUrl: string;
};

type SaveSceneArgs = {
  json: string;
  roomUrl?: string;
};

type InspectRoomArgs = {
  roomUrl?: string;
};

type RoomSceneSummary = {
  activeElements: number;
  activeImageElements: number;
  cleanupCandidateFileIds: string[];
  deletedElements: number;
  fileIdsReferenced: string[];
  imageElements: number;
  missingFileIds: string[];
  totalElements: number;
  unreferencedFileIds: string[];
};

type RoomSaveResult = {
  broadcastedLiveUpdate: boolean;
  orphanedFileIds: string[];
  previousSceneVersion: number;
  roomId: string;
  roomUrl: string;
  sceneVersion: number;
  skippedUnreferencedFileIds: string[];
  summary: RoomSceneSummary;
  totalUploadedBytes: number;
  uploadedFileIds: string[];
};

type RoomInspectionResult = {
  roomId: string;
  roomUrl: string;
  sceneVersion: number;
  summary: RoomSceneSummary;
};

const DEFAULT_ROOM_URL = process.env.EXCALIDRAW_SELF_HOSTED_ROOM_URL ?? "";
const DEFAULT_COLLAB_SERVER_URL =
  process.env.EXCALIDRAW_SELF_HOSTED_COLLAB_URL ??
  process.env.EXCALIDRAW_COLLAB_SERVER_URL ??
  "https://excalidraw-collab.sitesoftllc.net";
const DEFAULT_FIREBASE_CONFIG_JSON =
  process.env.EXCALIDRAW_FIREBASE_CONFIG ??
  process.env.EXCALIDRAW_SELF_HOSTED_FIREBASE_CONFIG ??
  '{"apiKey":"AIzaSyAd15pYlMci_xIp9ko6wkEsDzAAA0Dn0RU","authDomain":"excalidraw-room-persistence.firebaseapp.com","databaseURL":"https://excalidraw-room-persistence.firebaseio.com","projectId":"excalidraw-room-persistence","storageBucket":"excalidraw-room-persistence.appspot.com","messagingSenderId":"654800341332","appId":"1:654800341332:web:4a692de832b55bd57ce0c1"}';

const SOCKET_EVENT_INIT_ROOM = "init-room";
const SOCKET_EVENT_JOIN_ROOM = "join-room";
const SOCKET_EVENT_ROOM_USER_CHANGE = "room-user-change";
const SOCKET_EVENT_FIRST_IN_ROOM = "first-in-room";
const SOCKET_EVENT_SERVER_BROADCAST = "server-broadcast";
const WS_SUBTYPE_UPDATE = "SCENE_UPDATE";
const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const FILE_CACHE_MAX_AGE_SEC = 31536000;
const FILES_PREFIX = "/files/rooms";
const CONCAT_BUFFERS_VERSION = 1;
const VERSION_DATAVIEW_BYTES = 4;
const NEXT_CHUNK_SIZE_DATAVIEW_BYTES = 4;
let firebaseApp: FirebaseApp | null = null;

function sortedStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseFirebaseConfig(): FirebaseConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DEFAULT_FIREBASE_CONFIG_JSON);
  } catch (error) {
    throw new Error(`Invalid Firebase config JSON: ${(error as Error).message}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as FirebaseConfig).projectId !== "string" ||
    typeof (parsed as FirebaseConfig).apiKey !== "string"
  ) {
    throw new Error("Firebase config must include string apiKey and projectId values.");
  }

  return parsed as FirebaseConfig;
}

function parseRoomUrl(roomUrl: string): ParsedRoom {
  const url = new URL(roomUrl);
  const match = url.hash.match(/^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/);
  if (!match) {
    throw new Error("Room URL must contain a #room=<roomId>,<roomKey> hash.");
  }

  return {
    roomId: match[1],
    roomKey: match[2],
    roomUrl: url.toString(),
  };
}

function resolveRoomUrl(roomUrl?: string): ParsedRoom {
  const resolved = roomUrl?.trim() || DEFAULT_ROOM_URL;
  if (!resolved) {
    throw new Error(
      "No room URL provided. Set EXCALIDRAW_SELF_HOSTED_ROOM_URL or pass roomUrl explicitly.",
    );
  }
  return parseRoomUrl(resolved);
}

function decodeSceneJson(json: string): {
  elements: ExcalidrawElementLike[];
  files: Record<string, BinaryFileLike>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid Excalidraw JSON: ${(error as Error).message}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { elements?: unknown[] }).elements)
  ) {
    throw new Error("Serialized Excalidraw JSON is missing an elements array.");
  }

  return {
    elements: (parsed as { elements: ExcalidrawElementLike[] }).elements,
    files:
      (parsed as { files?: Record<string, BinaryFileLike> }).files &&
      typeof (parsed as { files?: Record<string, BinaryFileLike> }).files === "object"
        ? (parsed as { files: Record<string, BinaryFileLike> }).files
        : {},
  };
}

function getReferencedFileIds(elements: ExcalidrawElementLike[]): Set<string> {
  return new Set(
    elements.flatMap((element) =>
      !element.isDeleted && element.type === "image" && element.fileId ? [element.fileId] : [],
    ),
  );
}

function getDeletedFileIds(elements: ExcalidrawElementLike[]): Set<string> {
  return new Set(
    elements.flatMap((element) =>
      element.isDeleted && element.type === "image" && element.fileId ? [element.fileId] : [],
    ),
  );
}

function difference(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return sortedStrings(Array.from(left).filter((value) => !rightSet.has(value)));
}

function createSceneSummary(
  elements: ExcalidrawElementLike[],
  files: Record<string, BinaryFileLike> = {},
  assumedExistingFileIds: Iterable<string> = [],
): RoomSceneSummary {
  const totalElements = elements.length;
  const activeElements = elements.filter((element) => !element.isDeleted);
  const deletedElements = totalElements - activeElements.length;
  const imageElements = elements.filter((element) => element.type === "image").length;
  const activeImageElements = activeElements.filter((element) => element.type === "image").length;
  const referencedFileIds = getReferencedFileIds(elements);
  const providedFileIds = new Set(Object.keys(files));
  const availableFileIds = new Set([...providedFileIds, ...assumedExistingFileIds]);
  const deletedFileIds = getDeletedFileIds(elements);

  return {
    totalElements,
    activeElements: activeElements.length,
    deletedElements,
    imageElements,
    activeImageElements,
    fileIdsReferenced: sortedStrings(referencedFileIds),
    missingFileIds: difference(referencedFileIds, availableFileIds),
    unreferencedFileIds: difference(providedFileIds, referencedFileIds),
    cleanupCandidateFileIds: difference(deletedFileIds, referencedFileIds),
  };
}

async function importRoomKey(roomKey: string, usage: "encrypt" | "decrypt") {
  return globalThis.crypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: roomKey,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    {
      name: "AES-GCM",
      length: 128,
    },
    false,
    [usage],
  );
}

async function encryptBuffer(
  roomKey: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const key = await importRoomKey(roomKey, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = Uint8Array.from(plaintext);
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes,
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    iv,
  };
}

function dataView(
  buffer: Uint8Array,
  bytes: 1 | 2 | 4,
  offset: number,
  value?: number,
): Uint8Array | number {
  const bits = bytes === 1 ? 8 : bytes === 2 ? 16 : 32;
  if (value != null) {
    const method = `setUint${bits}` as const;
    new DataView(buffer.buffer)[method](offset, value);
    return buffer;
  }
  const method = `getUint${bits}` as const;
  return new DataView(buffer.buffer)[method](offset);
}

function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const bufferView = new Uint8Array(
    VERSION_DATAVIEW_BYTES +
      NEXT_CHUNK_SIZE_DATAVIEW_BYTES * buffers.length +
      buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0),
  );

  let cursor = 0;
  dataView(bufferView, VERSION_DATAVIEW_BYTES, cursor, CONCAT_BUFFERS_VERSION);
  cursor += VERSION_DATAVIEW_BYTES;

  for (const buffer of buffers) {
    dataView(
      bufferView,
      NEXT_CHUNK_SIZE_DATAVIEW_BYTES,
      cursor,
      buffer.byteLength,
    );
    cursor += NEXT_CHUNK_SIZE_DATAVIEW_BYTES;
    bufferView.set(buffer, cursor);
    cursor += buffer.byteLength;
  }

  return bufferView;
}

async function encodeFileForUpload(
  fileId: string,
  fileData: BinaryFileLike,
  roomKey: string,
): Promise<Uint8Array> {
  const sourceBytes = new TextEncoder().encode(fileData.dataURL);
  const contentsMetadataBuffer = new TextEncoder().encode(
    JSON.stringify({
      id: fileId,
      mimeType: fileData.mimeType ?? "application/octet-stream",
      created: fileData.created ?? Date.now(),
      lastRetrieved: fileData.lastRetrieved ?? Date.now(),
    }),
  );
  const encodingMetadataBuffer = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      compression: "pako@1",
      encryption: "AES-GCM",
    }),
  );
  const compressed = deflate(concatBuffers(contentsMetadataBuffer, sourceBytes));
  const { ciphertext, iv } = await encryptBuffer(roomKey, compressed);
  return concatBuffers(encodingMetadataBuffer, iv, ciphertext);
}

async function encryptElements(
  roomKey: string,
  elements: ExcalidrawElementLike[],
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(elements));
  return encryptBuffer(roomKey, plaintext);
}

async function decryptElements(
  roomKey: string,
  document: FirestoreDocument,
): Promise<ExcalidrawElementLike[]> {
  const iv = document.fields?.iv;
  const ciphertext = document.fields?.ciphertext;
  if (!iv || !("bytesValue" in iv) || !ciphertext || !("bytesValue" in ciphertext)) {
    return [];
  }

  const key = await importRoomKey(roomKey, "decrypt");
  const decrypted = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(iv.bytesValue, "base64"),
    },
    key,
    Buffer.from(ciphertext.bytesValue, "base64"),
  );

  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted))) as ExcalidrawElementLike[];
}

function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function getFirebaseApp(firebaseConfig: FirebaseConfig): FirebaseApp {
  if (firebaseApp) {
    return firebaseApp;
  }
  firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return firebaseApp;
}

async function saveFilesToFirebaseStorage(
  firebaseConfig: FirebaseConfig,
  roomId: string,
  roomKey: string,
  files: Record<string, BinaryFileLike>,
  fileIdsToUpload: Set<string>,
): Promise<{
  skippedUnreferencedFileIds: string[];
  totalUploadedBytes: number;
  uploadedFileIds: string[];
}> {
  const storage = getStorage(getFirebaseApp(firebaseConfig));
  const uploadedFileIds = new Set<string>();
  const fileEntries = Object.entries(files);
  const skippedUnreferencedFileIds = difference(
    new Set(fileEntries.map(([fileId]) => fileId)),
    fileIdsToUpload,
  );
  const oversizedFiles: string[] = [];
  let totalUploadedBytes = 0;

  await Promise.all(
    fileEntries.map(async ([fileId, fileData]) => {
      if (!fileIdsToUpload.has(fileId) || !fileData?.dataURL) {
        return;
      }

      const sourceBytes = new TextEncoder().encode(fileData.dataURL);
      if (sourceBytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
        oversizedFiles.push(`${fileId} (${formatBytes(sourceBytes.byteLength)})`);
        return;
      }

      const encodedFile = await encodeFileForUpload(fileId, fileData, roomKey);

      const storageRef = ref(storage, `${FILES_PREFIX}/${roomId}/${fileId}`);
      await uploadBytes(storageRef, encodedFile, {
        cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        contentType: "application/octet-stream",
      });
      totalUploadedBytes += sourceBytes.byteLength;
      uploadedFileIds.add(fileId);
    }),
  );

  if (oversizedFiles.length) {
    throw new Error(
      `Files exceed ${Math.trunc(FILE_UPLOAD_MAX_BYTES / 1024 / 1024)}MB each: ${oversizedFiles.join(", ")}`,
    );
  }

  return {
    uploadedFileIds: sortedStrings(uploadedFileIds),
    skippedUnreferencedFileIds,
    totalUploadedBytes,
  };
}

function markUploadedImageElements(
  elements: ExcalidrawElementLike[],
  savedFileIds: Set<string>,
): ExcalidrawElementLike[] {
  if (!savedFileIds.size) {
    return elements;
  }

  return elements.map((element) => {
    if (element.type === "image" && element.fileId && savedFileIds.has(element.fileId)) {
      return {
        ...element,
        status: "saved",
      };
    }
    return element;
  });
}

function firestoreDocumentUrl(projectId: string, roomId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/scenes/${roomId}`;
}

async function readExistingScene(
  projectId: string,
  roomId: string,
): Promise<{ document: FirestoreDocument | null; sceneVersion: number }> {
  const response = await fetch(firestoreDocumentUrl(projectId, roomId));
  if (response.status === 404) {
    return { document: null, sceneVersion: 0 };
  }
  if (!response.ok) {
    throw new Error(`Failed to read room scene: ${response.status} ${response.statusText}`);
  }

  const document = (await response.json()) as FirestoreDocument;
  const raw = document.fields?.sceneVersion;
  const sceneVersion = raw && "integerValue" in raw ? Number.parseInt(raw.integerValue, 10) || 0 : 0;
  return { document, sceneVersion };
}

function randomVersionNonce(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] || Math.floor(Math.random() * 2 ** 31);
}

function createDeletedTombstone(
  previousElement: ExcalidrawElementLike,
  updatedAt: number,
): ExcalidrawElementLike {
  return {
    ...previousElement,
    isDeleted: true,
    updated: updatedAt,
    version: (previousElement.version ?? 1) + 1,
    versionNonce: randomVersionNonce(),
  };
}

function buildBroadcastElements(
  nextElements: ExcalidrawElementLike[],
  previousElements: ExcalidrawElementLike[],
): ExcalidrawElementLike[] {
  const updatedAt = Date.now();
  const nextIds = new Set(nextElements.map((element) => element.id));
  const tombstones = previousElements
    .filter((element) => !nextIds.has(element.id) && !element.isDeleted)
    .map((element) => createDeletedTombstone(element, updatedAt));
  return [...nextElements, ...tombstones];
}

async function openSocketAndJoinRoom(roomId: string): Promise<Socket> {
  const socket = io(DEFAULT_COLLAB_SERVER_URL, {
    transports: ["websocket", "polling"],
    reconnection: false,
    timeout: 5000,
    forceNew: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for collab connection.")), 7000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect_error", onError);
      socket.off(SOCKET_EVENT_INIT_ROOM, onInitRoom);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onInitRoom = () => {
      cleanup();
      resolve();
    };
    socket.once("connect_error", onError);
    socket.once(SOCKET_EVENT_INIT_ROOM, onInitRoom);
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out joining collab room.")), 7000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect_error", onError);
      socket.off(SOCKET_EVENT_FIRST_IN_ROOM, onJoined);
      socket.off(SOCKET_EVENT_ROOM_USER_CHANGE, onRoomUserChange);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onJoined = () => {
      cleanup();
      resolve();
    };
    const onRoomUserChange = (clients: string[]) => {
      if (clients.includes(socket.id ?? "")) {
        cleanup();
        resolve();
      }
    };
    socket.once("connect_error", onError);
    socket.once(SOCKET_EVENT_FIRST_IN_ROOM, onJoined);
    socket.on(SOCKET_EVENT_ROOM_USER_CHANGE, onRoomUserChange);
    socket.emit(SOCKET_EVENT_JOIN_ROOM, roomId);
  });

  return socket;
}

async function broadcastSceneUpdate(
  room: ParsedRoom,
  elements: ExcalidrawElementLike[],
): Promise<boolean> {
  const socket = await openSocketAndJoinRoom(room.roomId);
  try {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: WS_SUBTYPE_UPDATE,
        payload: { elements },
      }),
    );
    const { ciphertext, iv } = await encryptBuffer(room.roomKey, payload);
    socket.emit(SOCKET_EVENT_SERVER_BROADCAST, room.roomId, ciphertext.buffer, iv);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return true;
  } finally {
    socket.close();
  }
}

export async function saveSceneToSelfHostedRoom({
  json,
  roomUrl,
}: SaveSceneArgs): Promise<RoomSaveResult> {
  const firebaseConfig = parseFirebaseConfig();
  const room = resolveRoomUrl(roomUrl);
  const { elements, files } = decodeSceneJson(json);
  const { document, sceneVersion: previousVersion } = await readExistingScene(
    firebaseConfig.projectId,
    room.roomId,
  );
  const previousElements = document ? await decryptElements(room.roomKey, document) : [];
  const previousFileIds = getReferencedFileIds(previousElements);
  const summary = createSceneSummary(elements, files, previousFileIds);
  if (summary.missingFileIds.length) {
    throw new Error(
      `Image elements reference missing files: ${summary.missingFileIds.join(", ")}`,
    );
  }
  const fileIdsToUpload = new Set(summary.fileIdsReferenced.filter((fileId) => !previousFileIds.has(fileId)));
  const { uploadedFileIds, skippedUnreferencedFileIds, totalUploadedBytes } =
    await saveFilesToFirebaseStorage(
      firebaseConfig,
      room.roomId,
      room.roomKey,
      files,
      fileIdsToUpload,
    );
  const persistedElements = markUploadedImageElements(elements, new Set(uploadedFileIds));
  const broadcastElements = buildBroadcastElements(persistedElements, previousElements);
  const { ciphertext, iv } = await encryptElements(room.roomKey, persistedElements);
  const nextVersion = previousVersion + 1;

  const response = await fetch(
    `${firestoreDocumentUrl(firebaseConfig.projectId, room.roomId)}?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          sceneVersion: { integerValue: String(nextVersion) },
          iv: { bytesValue: encodeBytes(iv) },
          ciphertext: { bytesValue: encodeBytes(ciphertext) },
        },
      }),
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to write room scene: ${response.status} ${response.statusText} ${message}`);
  }

  let broadcastedLiveUpdate = false;
  if (DEFAULT_COLLAB_SERVER_URL) {
    broadcastedLiveUpdate = await broadcastSceneUpdate(room, broadcastElements);
  }

  return {
    broadcastedLiveUpdate,
    previousSceneVersion: previousVersion,
    roomUrl: room.roomUrl,
    roomId: room.roomId,
    sceneVersion: nextVersion,
    uploadedFileIds,
    skippedUnreferencedFileIds,
    totalUploadedBytes,
    orphanedFileIds: difference(previousFileIds, summary.fileIdsReferenced),
    summary,
  };
}

export async function inspectSelfHostedRoom({
  roomUrl,
}: InspectRoomArgs = {}): Promise<RoomInspectionResult> {
  const firebaseConfig = parseFirebaseConfig();
  const room = resolveRoomUrl(roomUrl);
  const { document, sceneVersion } = await readExistingScene(firebaseConfig.projectId, room.roomId);
  const elements = document ? await decryptElements(room.roomKey, document) : [];
  const referencedFileIds = getReferencedFileIds(elements);

  return {
    roomId: room.roomId,
    roomUrl: room.roomUrl,
    sceneVersion,
    summary: createSceneSummary(elements, {}, referencedFileIds),
  };
}

export function getDefaultSelfHostedRoomUrl(): string {
  return DEFAULT_ROOM_URL;
}
