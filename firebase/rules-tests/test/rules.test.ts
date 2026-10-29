import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const A = 'uid-a';
const B = 'uid-b';
const C = 'uid-c';
const CID = 'duo';

const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

const KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

let env: RulesTestEnvironment;

function dbFor(uid: string) {
  return env.authenticatedContext(uid).firestore();
}

function messagePayload(senderId: string, overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-1',
    senderId,
    text: 'Hello from the rules test',
    clientCreatedAt: Date.now(),
    createdAt: serverTimestamp(),
    type: 'text',
    clientMessageId: 'msg-1',
    transport: 'cloud',
    ...overrides,
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-duochat',
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'config', 'access'), {
      memberIds: [A, B],
      conversationId: CID,
    });
    await setDoc(doc(db, 'conversations', CID), {
      memberIds: [A, B],
      createdAt: new Date(),
      lastMessageAt: new Date(),
    });
    for (const uid of [A, B]) {
      await setDoc(doc(db, 'users', uid), {
        displayName: `User ${uid}`,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
    }
    await setDoc(doc(db, 'users', A, 'devices', 'device-a'), {
      publicKeyJwk: KEY,
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
  });
});

describe('two-user access control', () => {
  it('allows members to read the allowlist but denies outsiders', async () => {
    await assertSucceeds(getDoc(doc(dbFor(A), 'config', 'access')));
    await assertSucceeds(getDoc(doc(dbFor(B), 'config', 'access')));
    await assertFails(getDoc(doc(dbFor(C), 'config', 'access')));
  });

  it('denies unapproved accounts any conversation access', async () => {
    const db = dbFor(C);
    await assertFails(getDoc(doc(db, 'conversations', CID, 'messages', 'anything')));
    await assertFails(
      setDoc(doc(db, 'conversations', CID, 'messages', 'msg-c'), messagePayload(C)),
    );
    await assertFails(
      setDoc(doc(db, 'users', C), {
        displayName: 'Mallory',
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      }),
    );
  });

  it('never lets a member change membership or the allowlist', async () => {
    const db = dbFor(A);
    await assertFails(
      updateDoc(doc(db, 'conversations', CID), { memberIds: [A, C] }),
    );
    await assertFails(
      updateDoc(doc(db, 'config', 'access'), { memberIds: [A, C] }),
    );
  });

  it('restricts profiles to the two members and to the owner account', async () => {
    await assertSucceeds(
      updateDoc(doc(dbFor(A), 'users', A), {
        displayName: 'Alice',
        lastSeenAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(getDoc(doc(dbFor(A), 'users', B)));
    await assertFails(
      updateDoc(doc(dbFor(A), 'users', B), { displayName: 'Not allowed' }),
    );
    await assertFails(getDoc(doc(dbFor(C), 'users', A)));
  });

  it('validates device public keys and rejects private material', async () => {
    await assertSucceeds(
      setDoc(doc(dbFor(A), 'users', A, 'devices', 'device-b'), {
        publicKeyJwk: KEY,
        lastSeenAt: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(dbFor(A), 'users', A, 'devices', 'device-c'), {
        publicKeyJwk: { ...KEY, d: 'private-key-material' },
      }),
    );
    await assertSucceeds(getDoc(doc(dbFor(B), 'users', A, 'devices', 'device-a')));
    await assertFails(getDoc(doc(dbFor(C), 'users', A, 'devices', 'device-a')));
  });
});

describe('message integrity', () => {
  it('accepts a valid sender-authored message and rejects spoofing', async () => {
    const db = dbFor(A);
    await assertSucceeds(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'msg-1'),
        messagePayload(A),
      ),
    );
    await assertSucceeds(getDoc(doc(dbFor(B), 'conversations', CID, 'messages', 'msg-1')));
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'msg-2'),
        messagePayload(B, { messageId: 'msg-2', clientMessageId: 'msg-2' }),
      ),
    );
  });

  it('rejects invalid text, transport, extra fields, and mismatched ids', async () => {
    const db = dbFor(A);
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'bad-1'),
        messagePayload(A, { messageId: 'bad-1', clientMessageId: 'bad-1', text: '' }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'bad-2'),
        messagePayload(A, {
          messageId: 'bad-2',
          clientMessageId: 'bad-2',
          text: 'x'.repeat(16001),
        }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'bad-3'),
        messagePayload(A, {
          messageId: 'bad-3',
          clientMessageId: 'bad-3',
          transport: 'carrier-pigeon',
        }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'bad-4'),
        messagePayload(A, {
          messageId: 'bad-4',
          clientMessageId: 'bad-4',
          admin: true,
        }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'good-id'),
        messagePayload(A, { messageId: 'different-id', clientMessageId: 'good-id' }),
      ),
    );
  });

  it('permits idempotent retries but not content changes or deletes', async () => {
    const db = dbFor(A);
    const path = doc(db, 'conversations', CID, 'messages', 'msg-1');
    const payload = messagePayload(A);
    await assertSucceeds(setDoc(path, payload));
    await assertSucceeds(setDoc(path, payload));
    await assertFails(setDoc(path, messagePayload(A, { text: 'Changed content' })));
    await assertFails(
      setDoc(
        doc(dbFor(B), 'conversations', CID, 'messages', 'msg-1'),
        messagePayload(B, { text: 'Peer overwrite' }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'messages', 'msg-1'),
        messagePayload(A, { deleted: true }),
      ),
    );
    await assertFails(deleteDoc(path));
  });

  it('only allows a user to write their own read state', async () => {
    await assertSucceeds(
      setDoc(doc(dbFor(A), 'conversations', CID, 'readStates', A), {
        lastReadMessageId: 'msg-1',
        lastReadAt: serverTimestamp(),
      }),
    );
    await assertFails(
      setDoc(doc(dbFor(A), 'conversations', CID, 'readStates', B), {
        lastReadMessageId: 'msg-1',
        lastReadAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(getDoc(doc(dbFor(B), 'conversations', CID, 'readStates', A)));
  });
});

describe('WebRTC signaling', () => {
  function signal(overrides: Record<string, unknown> = {}) {
    return {
      from: A,
      to: B,
      fromDeviceId: 'device-a',
      kind: 'offer',
      sdp: 'v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\n',
      createdAt: serverTimestamp(),
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  it('lets a member send a signal only to the other member', async () => {
    const db = dbFor(A);
    await assertSucceeds(
      setDoc(doc(db, 'conversations', CID, 'signals', 'sig-1'), signal()),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'signals', 'sig-2'),
        signal({ to: C }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'signals', 'sig-3'),
        signal({ from: B }),
      ),
    );
    await assertFails(
      setDoc(
        doc(db, 'conversations', CID, 'signals', 'sig-4'),
        signal({ kind: 'sdp-magic' }),
      ),
    );
  });

  it('only exposes a signal to its addressed recipient', async () => {
    await assertSucceeds(
      setDoc(doc(dbFor(A), 'conversations', CID, 'signals', 'sig-1'), signal()),
    );
    await assertFails(getDoc(doc(dbFor(A), 'conversations', CID, 'signals', 'sig-1')));
    await assertSucceeds(getDoc(doc(dbFor(B), 'conversations', CID, 'signals', 'sig-1')));
    await assertFails(getDoc(doc(dbFor(C), 'conversations', CID, 'signals', 'sig-1')));
    await assertSucceeds(
      env.withSecurityRulesDisabled(async (context) =>
        getDoc(doc(context.firestore(), 'conversations', CID, 'signals', 'sig-1')),
      ),
    );
  });

  it('prevents signal updates and lets only the recipient delete', async () => {
    await assertSucceeds(
      setDoc(doc(dbFor(A), 'conversations', CID, 'signals', 'sig-1'), signal()),
    );
    await assertFails(
      updateDoc(doc(dbFor(A), 'conversations', CID, 'signals', 'sig-1'), {
        kind: 'answer',
      }),
    );
    await assertFails(
      deleteDoc(doc(dbFor(A), 'conversations', CID, 'signals', 'sig-1')),
    );
    await assertSucceeds(
      deleteDoc(doc(dbFor(B), 'conversations', CID, 'signals', 'sig-1')),
    );
  });
});
