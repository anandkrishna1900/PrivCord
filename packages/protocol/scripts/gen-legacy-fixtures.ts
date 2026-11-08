/**
 * Generates docs/legacy-fixtures.json: rows for the desktop and Android databases as the existing apps write them, so
 * the Rust importer can be tested on realistic data. People, cards and group events are made by the real protocol code;
 * text is encrypted exactly like `apps/desktop/src/lib/encryption.ts` (AES-256-GCM, 12-byte IV, `enc1.<iv>.<ct>`).
 * The row layouts are the apps' own table definitions (`localDb.ts`, `DuoDatabase.kt`). Not captured from a device.
 * Run from packages/protocol: `npx vite-node scripts/gen-legacy-fixtures.ts`. Test keys and phrases only.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { GroupCoordinator, deriveIdentityFromPhrase, sealBackup, uidFromDh, type ContactCard } from '../src';

const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const key = await crypto.subtle.importKey('raw', KEY, { name: 'AES-GCM' }, false, ['encrypt']);
let ivCounter = 0;
const nextIv = () => { const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, ++ivCounter); return iv; };
async function enc(text: string): Promise<string> {
  const iv = nextIv();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  return `enc1.${b64u(iv)}.${b64u(ct)}`;
}
async function encBytes(bytes: Uint8Array): Promise<string> {
  const iv = nextIv();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return hex(new Uint8Array([...iv, ...ct]));
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64url');

async function person(i: number, name?: string) {
  const phrase = entropyToMnemonic(new Uint8Array(16).fill(0x70 + i), wordlist);
  const { identity } = await deriveIdentityFromPhrase(phrase);
  const card: ContactCard = { v: 1, sign: identity.signKey.pubJwk, dh: identity.dhKey.pubJwk, proof: identity.identityProof, ...(name ? { name } : {}) };
  return { phrase, uid: await uidFromDh(identity.dhKey.pubJwk), card, signPriv: identity.signKey.privJwk };
}
const [me, bob, carol, dave, eve] = await Promise.all([person(0, 'Me'), person(1, 'Bob'), person(2, 'Carol'), person(3, 'Dave'), person(4)]);

// A real group made by the real coordinator, plus a copy of one event with a flipped byte.
const coord = new GroupCoordinator({ ownUid: me.uid, ownCard: me.card, signPriv: me.signPriv, knownUids: () => new Set(), now: () => 1_700_000_000_000 });
const { groupId } = await coord.createGroup('Trip', [bob.card, carol.card]);
const groupEvents = coord.export()[groupId]!;
const tampered = JSON.parse(JSON.stringify(groupEvents[1]));
tampered.ts += 1;
const bogusGroup = { id: 'f'.repeat(64), events: [tampered] };

const png = new Uint8Array(5000).map((_, i) => (i * 31) & 0xff);
const png2 = new Uint8Array(900).map((_, i) => (i * 13) & 0xff);
const T = 1_700_000_100_000;
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Msg = {
  id: string; sender: string; text: string; at: number; conv: string; state: string; type?: 'text' | 'file'; transport?: string;
  readAt?: number | null; extra?: unknown; recips?: Record<string, string>; undecryptable?: boolean;
};
const msgs: Msg[] = [
  { id: mid(1), sender: bob.uid, text: 'hello from Bob 😀', at: T + 1, conv: bob.uid, state: 'READ', readAt: T + 5 },
  { id: mid(2), sender: me.uid, text: 'hi Bob, are you there?', at: T + 2, conv: bob.uid, state: 'SENT' },
  { id: mid(3), sender: bob.uid, text: 'yes! reply to you', at: T + 3, conv: bob.uid, state: 'DELIVERED', extra: { replyTo: { id: mid(2), author: me.uid, preview: 'hi Bob, are you there?' } } },
  { id: mid(4), sender: me.uid, text: 'photo.png', at: T + 4, conv: bob.uid, state: 'DELIVERED', type: 'file', extra: { file: { name: 'photo.png', mime: 'image/png', size: png.length, sha256: sha(png) } } },
  { id: mid(5), sender: bob.uid, text: 'broken.bin', at: T + 5, conv: bob.uid, state: 'DELIVERED', type: 'file', extra: { file: { name: 'broken.bin', mime: 'application/octet-stream', size: png2.length, sha256: sha(png2) } } },
  { id: mid(6), sender: bob.uid, text: 'gone.txt', at: T + 6, conv: bob.uid, state: 'DELIVERED', type: 'file', extra: { file: { name: 'gone.txt', mime: 'text/plain', size: 10, sha256: sha(new Uint8Array(10)) } } },
  { id: mid(7), sender: carol.uid, text: 'group hello', at: T + 7, conv: groupId, state: 'DELIVERED' },
  { id: mid(8), sender: me.uid, text: 'group reply from me', at: T + 8, conv: groupId, state: 'SENT', recips: { [bob.uid]: 'SENT', [carol.uid]: 'DELIVERED' } },
  { id: mid(9), sender: carol.uid, text: 'anyone near the cafe?', at: T + 9, conv: 'chan:town', state: 'DELIVERED', extra: { senderName: 'Carol · 1a2b' } },
  { id: mid(10), sender: bob.uid, text: '', at: T + 10, conv: bob.uid, state: 'DELIVERED', extra: { deleted: true } },
  { id: mid(11), sender: bob.uid, text: 'liked this', at: T + 11, conv: bob.uid, state: 'DELIVERED', extra: { reactions: { [me.uid]: '👍' } } },
  { id: mid(12), sender: bob.uid, text: 'lost key', at: T + 12, conv: bob.uid, state: 'DELIVERED', undecryptable: true },
  { id: mid(13), sender: eve.uid, text: 'from a stranger', at: T + 13, conv: eve.uid, state: 'DELIVERED' },
  { id: mid(14), sender: me.uid, text: 'never sent', at: T + 14, conv: bob.uid, state: 'QUEUED' },
  { id: mid(15), sender: me.uid, text: 'failed once', at: T + 15, conv: bob.uid, state: 'FAILED' },
];
const files: Record<string, { bytes: Uint8Array; stored?: Uint8Array }> = {
  [mid(4)]: { bytes: png },
  [mid(5)]: { bytes: png2.map((x, i) => (i === 100 ? x ^ 1 : x)) }, // one byte differs: fails its hash
};

async function msgText(m: Msg) { return m.undecryptable ? 'enc1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' : enc(m.text); }

const ccard = (p: typeof me) => p.card as unknown as Record<string, unknown>;
// ---- desktop rows
const desktop = {
  contacts: [
    { uid: bob.uid, card: ccard(bob), trust: 'verified', checked: true, nickname: 'Bobby', addedAt: T - 5000 },
    { uid: carol.uid, card: ccard(carol), trust: 'introduced', introducedBy: bob.uid, checked: false, addedAt: T - 4000 },
    { uid: dave.uid, card: { ...ccard(dave), proof: ccard(bob).proof }, trust: 'verified', checked: false, addedAt: T - 3000 }, // proof is someone else's
    { uid: eve.uid, card: ccard(eve), trust: 'confirmed', checked: true, addedAt: T - 2000 }, // older build wrote "confirmed"
  ],
  groups: { [groupId]: groupEvents, [bogusGroup.id]: bogusGroup.events },
  channels: ['Town', '###'],
  blocked: [carol.uid],
  meta: {} as Record<string, string>,
  messages: [] as unknown[],
  outbox: [] as unknown[],
  files: {} as Record<string, string>,
};
for (const [k, v] of Object.entries({ contacts: desktop.contacts, groups: desktop.groups, channels: desktop.channels, blocked: desktop.blocked })) desktop.meta[`secret.${k}`] = await enc(JSON.stringify(v));
for (const m of msgs) {
  desktop.messages.push({
    message_id: m.id, client_message_id: m.id, sender_id: m.sender, text_cipher: await msgText(m), client_created_at: m.at,
    message_type: m.type ?? 'text', transport: 'p2p', delivery_state: m.state, read_at: m.readAt ?? null, conversation_id: m.conv,
    recips: m.recips ? JSON.stringify(m.recips) : null, extra_cipher: m.extra ? await enc(JSON.stringify(m.extra)) : null,
  });
}
desktop.outbox.push({ message_id: mid(2), recipient_id: bob.uid, payload_cipher: await enc('{}'), created_at: T + 2, attempt_count: 2, last_attempt_at: T + 100, delivery_state: 'SENT', last_error: null });
desktop.outbox.push({ message_id: mid(14), recipient_id: bob.uid, payload_cipher: await enc('{}'), created_at: T + 14, attempt_count: 0, last_attempt_at: null, delivery_state: 'QUEUED', last_error: null });
for (const [id, f] of Object.entries(files)) desktop.files[id] = await encBytes(f.bytes);

// An old desktop database: only the pinned peer, messages without conversation ids.
const oldDesktop = {
  contacts: [{ uid: bob.uid, card: ccard(bob), trust: 'verified', checked: true, addedAt: T - 5000 }],
  meta: { 'secret.contacts': await enc(JSON.stringify([{ uid: bob.uid, card: ccard(bob), trust: 'verified', checked: true, addedAt: T - 5000 }])) },
  messages: [
    { message_id: mid(101), client_message_id: mid(101), sender_id: bob.uid, text_cipher: await enc('an old message'), client_created_at: T + 1, message_type: 'text', transport: 'p2p', delivery_state: 'READ', read_at: T + 2 },
    { message_id: mid(102), client_message_id: mid(102), sender_id: me.uid, text_cipher: await enc('and my answer'), client_created_at: T + 3, message_type: 'text', transport: 'relay', delivery_state: 'DELIVERED', read_at: null },
  ],
};

// ---- android rows (Room v7 column names)
const j = (p: typeof me, name: string, trust: string, extra: Record<string, unknown> = {}) => ({
  uid: p.uid, name, signPubX: p.card.sign.x, signPubY: p.card.sign.y, dhPubX: p.card.dh.x, dhPubY: p.card.dh.y, identityProof: p.card.proof,
  safetyNumber: '00000 00000', isBlocked: false, verifiedAt: null as number | null, createdAt: T - 5000, trust, introducedBy: null as string | null, cardName: p.card.name ?? null, ...extra,
});
const android = {
  contacts: [
    j(bob, 'Bobby', 'verified', { verifiedAt: T - 100 }),
    j(carol, 'Carol', 'introduced', { introducedBy: bob.uid, isBlocked: true, createdAt: T - 4000 }),
    j(dave, 'Dave', 'verified', { identityProof: bob.card.proof }),
  ],
  kv: { channels: await enc(JSON.stringify(['town'])), muted: await enc(JSON.stringify([])) },
  groupLogs: [{ groupId, eventsCipher: await enc(JSON.stringify(groupEvents)), updatedAt: T }, { groupId: bogusGroup.id, eventsCipher: await enc(JSON.stringify(bogusGroup.events)), updatedAt: T }],
  messages: [] as unknown[],
  outbox: [] as unknown[],
  files: {} as Record<string, string>,
};
for (const m of msgs.filter((x) => !x.undecryptable)) {
  android.messages.push({
    messageId: m.id, clientMessageId: m.id, senderId: m.sender, textCipher: await msgText(m), clientCreatedAt: m.at, transport: 'p2p', deliveryState: m.state,
    readAt: m.readAt ?? null, conversationId: m.conv, totalRecipients: m.recips ? 2 : 0, extraCipher: m.extra ? await enc(JSON.stringify(m.extra)) : null,
  });
}
android.messages.push({ messageId: mid(12), clientMessageId: mid(12), senderId: bob.uid, textCipher: await msgText(msgs[11]!), clientCreatedAt: T + 12, transport: 'p2p', deliveryState: 'DELIVERED', readAt: null, conversationId: bob.uid, totalRecipients: 0, extraCipher: null });
android.outbox.push({ key: `${mid(2)}|${bob.uid}`, messageId: mid(2), recipientId: bob.uid, payloadCipher: await enc('{}'), createdAt: T + 2, attemptCount: 2, lastAttemptAt: T + 100, deliveryState: 'SENT', lastError: null, conversationId: bob.uid });
android.outbox.push({ key: `${mid(8)}|${bob.uid}`, messageId: mid(8), recipientId: bob.uid, payloadCipher: await enc('{}'), createdAt: T + 8, attemptCount: 1, lastAttemptAt: T + 90, deliveryState: 'SENT', lastError: null, conversationId: groupId });
for (const [id, f] of Object.entries(files)) android.files[id] = hex(f.bytes);

// A backup file exactly as the desktop app's exportBackup writes it (its own sealBackup from the protocol package).
const backupData = {
  v: 1, uid: me.uid, at: T + 500,
  contacts: [{ uid: bob.uid, card: ccard(bob), trust: 'verified', checked: true, nickname: 'Bobby', addedAt: T - 5000 }],
  groups: { [groupId]: groupEvents },
  channels: ['town'],
  blocked: [carol.uid],
  messages: [
    { messageId: mid(201), clientMessageId: mid(201), senderId: bob.uid, text: 'from the backup', clientCreatedAt: T + 1, type: 'text', transport: 'p2p', deliveryState: 'READ', readAt: T + 2, conversationId: bob.uid, reactions: { [me.uid]: '👍' } },
    { messageId: mid(202), clientMessageId: mid(202), senderId: me.uid, text: '', clientCreatedAt: T + 3, type: 'text', transport: 'p2p', deliveryState: 'DELIVERED', readAt: null, conversationId: bob.uid, deleted: true },
    { messageId: mid(203), clientMessageId: mid(203), senderId: me.uid, text: 'group note', clientCreatedAt: T + 4, type: 'text', transport: 'p2p', deliveryState: 'SENT', readAt: null, conversationId: groupId, recipients: { [bob.uid]: 'SENT', [carol.uid]: 'DELIVERED' } },
    { messageId: mid(204), clientMessageId: mid(204), senderId: carol.uid, text: 'channel hello', clientCreatedAt: T + 5, type: 'text', transport: 'p2p', deliveryState: 'DELIVERED', readAt: null, conversationId: 'chan:town', senderName: 'Carol' },
  ],
};
const backup = await sealBackup(backupData, 'correct horse battery');

const out = {
  comment: 'Generated by packages/protocol/scripts/gen-legacy-fixtures.ts. Synthesised with the apps\' own protocol code and table layouts; not captured from a device.',
  aesKeyHex: hex(KEY),
  me: { uid: me.uid, phrase: me.phrase }, bob: { uid: bob.uid }, carol: { uid: carol.uid }, dave: { uid: dave.uid }, eve: { uid: eve.uid },
  groupId, bogusGroupId: bogusGroup.id, pngSha: sha(png), pngLen: png.length,
  desktop, oldDesktop, android, backup,
};
writeFileSync(new URL('../../../docs/legacy-fixtures.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote docs/legacy-fixtures.json', JSON.stringify({ messages: msgs.length, group: groupEvents.length }));
