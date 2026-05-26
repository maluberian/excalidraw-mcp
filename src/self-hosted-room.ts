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

type ParsedRoom = {
  roomId: string;
  roomKey: string;
  roomUrl: string;
};

type SaveSceneArgs = {
  json: string;
  roomUrl?: string;
};

const DEFAULT_ROOM_URL = process.env.EXCALIDRAW_SELF_HOSTED_ROOM_URL ?? "";
const DEFAULT_FIREBASE_CONFIG_JSON =
  process.env.EXCALIDRAW_FIREBASE_CONFIG ??
  process.env.EXCALIDRAW_SELF_HOSTED_FIREBASE_CONFIG ??
  '{"apiKey":"AIzaSyAd15pYlMci_xIp9ko6wkEsDzAAA0Dn0RU","authDomain":"excalidraw-room-persistence.firebaseapp.com","databaseURL":"https://excalidraw-room-persistence.firebaseio.com","projectId":"excalidraw-room-persistence","storageBucket":"excalidraw-room-persistence.appspot.com","messagingSenderId":"654800341332","appId":"1:654800341332:web:4a692de832b55bd57ce0c1"}';

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

function decodeSceneJson(json: string): { elements: unknown[] } {
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

  return { elements: (parsed as { elements: unknown[] }).elements };
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

async function encryptElements(
  roomKey: string,
  elements: unknown[],
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const key = await importRoomKey(roomKey, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(elements));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    iv,
  };
}

function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function firestoreDocumentUrl(projectId: string, roomId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/scenes/${roomId}`;
}

async function readExistingSceneVersion(projectId: string, roomId: string): Promise<number> {
  const response = await fetch(firestoreDocumentUrl(projectId, roomId));
  if (response.status === 404) {
    return 0;
  }
  if (!response.ok) {
    throw new Error(`Failed to read room scene: ${response.status} ${response.statusText}`);
  }

  const document = (await response.json()) as FirestoreDocument;
  const raw = document.fields?.sceneVersion;
  if (!raw || !("integerValue" in raw)) {
    return 0;
  }
  return Number.parseInt(raw.integerValue, 10) || 0;
}

export async function saveSceneToSelfHostedRoom({
  json,
  roomUrl,
}: SaveSceneArgs): Promise<{ roomUrl: string; roomId: string; sceneVersion: number }> {
  const firebaseConfig = parseFirebaseConfig();
  const room = resolveRoomUrl(roomUrl);
  const { elements } = decodeSceneJson(json);
  const previousVersion = await readExistingSceneVersion(firebaseConfig.projectId, room.roomId);
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

  return {
    roomUrl: room.roomUrl,
    roomId: room.roomId,
    sceneVersion: nextVersion,
  };
}

export function getDefaultSelfHostedRoomUrl(): string {
  return DEFAULT_ROOM_URL;
}
