import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  waitForPendingWrites,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  fromCloudMessage,
  toCloudMessagePayload,
  type ChatMessage,
} from '@duochat/protocol';
import { firebaseDb } from './firebase';

export interface AccessInfo {
  memberIds: [string, string];
  conversationId: string;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  photoURL: string | null;
  lastSeenAt: number | null;
}

export interface IncomingSignal {
  id: string;
  from: string;
  fromDeviceId: string;
  kind: 'offer' | 'answer';
  sdp: string;
  expiresAt: number;
}

function db() {
  return firebaseDb();
}

function messagesRef(conversationId: string) {
  return collection(db(), 'conversations', conversationId, 'messages');
}

function signalsRef(conversationId: string) {
  return collection(db(), 'conversations', conversationId, 'signals');
}

export async function loadAccess(expectedConversationId: string): Promise<AccessInfo> {
  const snapshot = await getDoc(doc(db(), 'config', 'access'));
  if (!snapshot.exists()) {
    throw new Error(
      'Owner setup is incomplete: config/access does not exist. Seed it with scripts/seed-firebase.mjs.',
    );
  }
  const data = snapshot.data();
  const memberIds = data.memberIds;
  if (
    !Array.isArray(memberIds) ||
    memberIds.length !== 2 ||
    !memberIds.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    throw new Error('config/access must contain exactly two member IDs.');
  }
  if (
    typeof data.conversationId !== 'string' ||
    data.conversationId !== expectedConversationId
  ) {
    throw new Error(
      `config/access.conversationId must be "${expectedConversationId}".`,
    );
  }
  return {
    memberIds: [memberIds[0] as string, memberIds[1] as string],
    conversationId: data.conversationId,
  };
}

export async function checkCloud(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db(), 'config', 'access'));
    return true;
  } catch {
    return false;
  }
}

function toMillis(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const maybe = value as { toMillis?: () => number };
  return typeof maybe.toMillis === 'function' ? maybe.toMillis() : null;
}

function profileFrom(uid: string, data: DocumentData | undefined): UserProfile {
  return {
    uid,
    displayName:
      typeof data?.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim()
        : 'DuoChat user',
    photoURL: typeof data?.photoURL === 'string' ? data.photoURL : null,
    lastSeenAt: toMillis(data?.lastSeenAt),
  };
}

export async function loadProfile(uid: string): Promise<UserProfile> {
  const snapshot = await getDoc(doc(db(), 'users', uid));
  return profileFrom(uid, snapshot.data());
}

export function subscribeProfile(
  uid: string,
  onChange: (profile: UserProfile) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db(), 'users', uid),
    (snapshot) => onChange(profileFrom(uid, snapshot.data())),
    onError,
  );
}

export async function ensureOwnProfile(
  uid: string,
  email: string,
  displayName: string,
): Promise<void> {
  const ref = doc(db(), 'users', uid);
  const snapshot = await getDoc(ref);
  const cleanName =
    displayName.trim().slice(0, 40) || email.split('@')[0]?.slice(0, 40) || 'DuoChat user';
  if (!snapshot.exists()) {
    await setDoc(ref, {
      displayName: cleanName,
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    });
  } else {
    await setDoc(ref, { lastSeenAt: serverTimestamp() }, { merge: true });
  }
}

export async function updateDisplayName(uid: string, displayName: string): Promise<void> {
  const clean = displayName.trim();
  if (clean.length === 0 || clean.length > 40) {
    throw new Error('Display name must be between 1 and 40 characters.');
  }
  await setDoc(
    doc(db(), 'users', uid),
    { displayName: clean, lastSeenAt: serverTimestamp() },
    { merge: true },
  );
}

export async function touchLastSeen(uid: string): Promise<void> {
  try {
    await setDoc(
      doc(db(), 'users', uid),
      { lastSeenAt: serverTimestamp() },
      { merge: true },
    );
  } catch {
    // Presence is best-effort.
  }
}

export async function registerDevice(
  uid: string,
  deviceId: string,
  publicKeyJwk: JsonWebKey,
): Promise<void> {
  await setDoc(
    doc(db(), 'users', uid, 'devices', deviceId),
    {
      publicKeyJwk: {
        kty: publicKeyJwk.kty,
        crv: publicKeyJwk.crv,
        x: publicKeyJwk.x,
        y: publicKeyJwk.y,
      },
      lastSeenAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function fetchPeerDeviceKey(
  uid: string,
  deviceId: string,
): Promise<JsonWebKey | null> {
  const snapshot = await getDoc(doc(db(), 'users', uid, 'devices', deviceId));
  if (!snapshot.exists()) return null;
  const jwk = snapshot.data().publicKeyJwk as JsonWebKey | undefined;
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

export interface MessagePage {
  messages: ChatMessage[];
  cursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

export function subscribeLatestMessages(
  conversationId: string,
  onPage: (messages: ChatMessage[], cursor: QueryDocumentSnapshot<DocumentData> | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const messagesQuery = query(
    messagesRef(conversationId),
    orderBy('createdAt', 'desc'),
    limit(100),
  );
  return onSnapshot(
    messagesQuery,
    (snapshot) => {
      const messages: ChatMessage[] = [];
      for (const document of snapshot.docs) {
        const parsed = fromCloudMessage(document.id, document.data());
        if (parsed.ok) messages.push(parsed.value);
      }
      onPage(
        messages.reverse(),
        snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1]! : null,
      );
    },
    onError,
  );
}

export async function fetchOlderMessages(
  conversationId: string,
  cursor: QueryDocumentSnapshot<DocumentData>,
): Promise<MessagePage> {
  const olderQuery = query(
    messagesRef(conversationId),
    orderBy('createdAt', 'desc'),
    startAfter(cursor),
    limit(50),
  );
  const snapshot = await getDocs(olderQuery);
  const messages: ChatMessage[] = [];
  for (const document of snapshot.docs) {
    const parsed = fromCloudMessage(document.id, document.data());
    if (parsed.ok) messages.push(parsed.value);
  }
  return {
    messages: messages.reverse(),
    cursor: snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1]! : cursor,
    hasMore: snapshot.docs.length === 50,
  };
}

/**
 * Writes a message and waits for backend acknowledgement. waitForPendingWrites
 * resolves only after the server accepts the write, so this is a real
 * transport-accepted check rather than a local-cache enqueue.
 */
export async function writeMessage(
  conversationId: string,
  message: ChatMessage,
  timeoutMs = 12_000,
): Promise<void> {
  await setDoc(doc(messagesRef(conversationId), message.messageId), {
    ...toCloudMessagePayload(message),
    createdAt: serverTimestamp(),
  });
  await Promise.race([
    waitForPendingWrites(db()),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Cloud write timed out.')), timeoutMs),
    ),
  ]);
}

export async function writeReadState(
  conversationId: string,
  uid: string,
  lastReadMessageId: string,
): Promise<void> {
  await setDoc(
    doc(db(), 'conversations', conversationId, 'readStates', uid),
    { lastReadMessageId, lastReadAt: serverTimestamp() },
    { merge: true },
  );
}

export function subscribePeerReadState(
  conversationId: string,
  peerUid: string,
  onChange: (lastReadMessageId: string | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db(), 'conversations', conversationId, 'readStates', peerUid),
    (snapshot) => {
      const id = snapshot.data()?.lastReadMessageId;
      onChange(typeof id === 'string' ? id : null);
    },
    onError,
  );
}

export async function sendSignal(
  conversationId: string,
  signal: {
    from: string;
    to: string;
    fromDeviceId: string;
    kind: 'offer' | 'answer';
    sdp: string;
  },
): Promise<void> {
  const ref = doc(signalsRef(conversationId));
  await setDoc(ref, {
    ...signal,
    createdAt: serverTimestamp(),
    expiresAt: Date.now() + 60_000,
  });
}

export function subscribeSignals(
  conversationId: string,
  uid: string,
  onSignal: (signal: IncomingSignal) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    query(signalsRef(conversationId), where('to', '==', uid), limit(20)),
    (snapshot) => {
      const now = Date.now();
      for (const document of snapshot.docs) {
        const data = document.data();
        if (
          typeof data.from !== 'string' ||
          typeof data.fromDeviceId !== 'string' ||
          (data.kind !== 'offer' && data.kind !== 'answer') ||
          typeof data.sdp !== 'string'
        ) {
          continue;
        }
        const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0;
        if (expiresAt > 0 && expiresAt < now) {
          void deleteDoc(document.ref);
          continue;
        }
        onSignal({
          id: document.id,
          from: data.from,
          fromDeviceId: data.fromDeviceId,
          kind: data.kind,
          sdp: data.sdp,
          expiresAt,
        });
      }
    },
    onError,
  );
}

export async function deleteSignals(
  conversationId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const batch = writeBatch(db());
  for (const id of ids) batch.delete(doc(signalsRef(conversationId), id));
  await batch.commit();
}
