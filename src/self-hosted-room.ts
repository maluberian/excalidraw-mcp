import { io, type Socket } from "socket.io-client";

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
  [key: string]: unknown;
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

type RoomSaveResult = {
  broadcastedLiveUpdate: boolean;
  roomId: string;
  roomUrl: string;
  sceneVersion: number;
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

function decodeSceneJson(json: string): { elements: ExcalidrawElementLike[] } {
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

  return { elements: (parsed as { elements: ExcalidrawElementLike[] }).elements };
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
  const { elements } = decodeSceneJson(json);
  const { document, sceneVersion: previousVersion } = await readExistingScene(
    firebaseConfig.projectId,
    room.roomId,
  );
  const previousElements = document ? await decryptElements(room.roomKey, document) : [];
  const broadcastElements = buildBroadcastElements(elements, previousElements);
  const { ciphertext, iv } = await encryptElements(room.roomKey, elements);
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
    roomUrl: room.roomUrl,
    roomId: room.roomId,
    sceneVersion: nextVersion,
  };
}

export function getDefaultSelfHostedRoomUrl(): string {
  return DEFAULT_ROOM_URL;
}
