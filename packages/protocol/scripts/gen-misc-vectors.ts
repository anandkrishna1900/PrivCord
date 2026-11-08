/**
 * Generates docs/misc-vectors.json: pairing records, reconnect backoff, kill-switch plans and reports, manual connection
 * codes and Nostr events as the TypeScript implementation makes them, so the Rust port can be checked against them.
 * Run from packages/protocol: `npx vite-node scripts/gen-misc-vectors.ts`. Test keys only.
 */
import { writeFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  APP_KILL_SWITCH_STEPS,
  CONVERSATION_KILL_SWITCH_STEPS,
  canAutoReconnect,
  createManualSignal,
  createPairingRecord,
  decodeManualSignal,
  derivePairingStatus,
  emptyReport,
  encodeBlob,
  encodeManualSignal,
  finishReport,
  parsePairingState,
  reconnectDelayMs,
  recordStep,
  runKillSwitch,
  serializePairingState,
  shouldPersistPairing,
  summarizeReport,
  type KillSwitchMode,
  type KillSwitchScope,
  type StepStatus,
} from '../src';

const x = 'A'.repeat(43);
const y = 'B'.repeat(43);
const jwk = { kty: 'EC', crv: 'P-256', x, y };
const dh = { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) };

// ---- pairing
const rec = createPairingRecord({ peerUid: 'uid1', peerDeviceId: 'dev1', publicKeyJwk: jwk, dhJwk: dh, safetyNumber: '12345 67890', now: 1000 });
const again = createPairingRecord({ peerUid: 'uid1', peerDeviceId: 'dev1', publicKeyJwk: jwk, safetyNumber: '12345 67890', previous: rec, now: 5000 });
const otherDevice = createPairingRecord({ peerUid: 'uid1', peerDeviceId: 'dev2', publicKeyJwk: jwk, safetyNumber: 'n', previous: rec, now: 9000 });
const state = (r: unknown, auto?: unknown) => JSON.stringify({ version: 1, record: r, autoReconnect: auto });
const parseCases: Array<{ name: string; raw: string | null; expected?: string }> = [
  { name: 'null', raw: null },
  { name: 'empty', raw: '' },
  { name: 'not json', raw: '{nope' },
  { name: 'wrong version', raw: JSON.stringify({ version: 2, record: rec, autoReconnect: true }) },
  { name: 'good', raw: state(rec, true) },
  { name: 'auto off', raw: state(rec, false) },
  { name: 'auto missing defaults to true', raw: JSON.stringify({ version: 1, record: rec }) },
  { name: 'auto wrong type defaults to true', raw: state(rec, 'yes') },
  { name: 'record with bad key', raw: state({ ...rec, publicKeyJwk: { ...jwk, x: 'short' } }, true) },
  { name: 'record with empty uid', raw: state({ ...rec, peerUid: '' }, true) },
  { name: 'record with bad dh', raw: state({ ...rec, dhJwk: { kty: 'RSA' } }, true) },
  { name: 'record for a different peer', raw: state(rec, true), expected: 'someone-else' },
  { name: 'record with non-finite time', raw: JSON.stringify({ version: 1, record: { ...rec, pairedAt: null }, autoReconnect: true }) },
];
const pairing = {
  record: rec,
  again,
  otherDevice,
  parse: parseCases.map((c) => {
    const s = parsePairingState(c.raw, c.expected);
    return { ...c, record: s.record, autoReconnect: s.autoReconnect, canAutoReconnect: canAutoReconnect(s) };
  }),
  serialized: serializePairingState({ record: rec, autoReconnect: false }),
  status: [false, true].flatMap((saved) => [false, true].flatMap((connected) => [false, true].flatMap((connecting) => [false, true].map((failed) => ({ saved, connected, connecting, failed, status: derivePairingStatus({ saved, connected, connecting, failed }) }))))),
  persist: ['verified', 'confirmed', 'introduced', 'unverified', ''].map((t) => ({ trust: t, persist: shouldPersistPairing(t) })),
  delays: [-3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 100].map((a) => ({ attempt: a, ms: reconnectDelayMs(a) })),
  delaysCustom: [
    { opts: { baseMs: 1000, maxMs: 10000 }, ms: [0, 1, 2, 3, 4, 8].map((a) => reconnectDelayMs(a, { baseMs: 1000, maxMs: 10000 })) },
    { opts: { baseMs: 0, maxMs: 10000 }, ms: [0, 3].map((a) => reconnectDelayMs(a, { baseMs: 0, maxMs: 10000 })) },
    { opts: { baseMs: 4000, maxMs: 1000 }, ms: [0, 3].map((a) => reconnectDelayMs(a, { baseMs: 4000, maxMs: 1000 })) },
  ],
};

// ---- kill switch
const modes: KillSwitchMode[] = ['local-only', 'local-plus-session-state'];
const scopes: KillSwitchScope[] = ['application', 'conversation'];
const summaries: unknown[] = [];
const allIds = (scope: KillSwitchScope, mode: KillSwitchMode) =>
  (scope === 'application' ? APP_KILL_SWITCH_STEPS : CONVERSATION_KILL_SWITCH_STEPS.filter((s) => !(s.id === 'conv.session.erase' && mode === 'local-only'))).map((s) => s.id);
for (const scope of scopes) {
  for (const mode of modes) {
    const ids = allIds(scope, mode);
    const mk = (statuses: Array<[string, StepStatus]>) => {
      const r = emptyReport(scope, mode, scope === 'conversation' ? 'peer1' : undefined, 100);
      for (const [id, st] of statuses) recordStep(r, id, st, st === 'failed' ? 'boom' : undefined);
      return finishReport(r, 200);
    };
    const cases: Array<[string, Array<[string, StepStatus]>]> = [
      ['all erased', ids.map((i) => [i, 'erased'])],
      ['one skipped', ids.map((i, n) => [i, n === 1 ? 'skipped' : 'erased'])],
      ['one failed', ids.map((i, n) => [i, n === 0 ? 'failed' : 'erased'])],
      ['one missing', ids.slice(1).map((i) => [i, 'erased'])],
      ['nothing', []],
      ['unknown step only', [['mystery', 'erased']]],
    ];
    for (const [name, st] of cases) {
      const report = mk(st as Array<[string, StepStatus]>);
      summaries.push({ name, scope, mode, report, summary: summarizeReport(report) });
    }
  }
}
// A run: step "keys.erase" throws, "network.shutdown" is skipped, the rest erase; and a resume that skips finished steps.
async function run() {
  const outcomes: Record<string, 'erased' | 'skipped' | 'throw'> = { 'network.shutdown': 'skipped', 'keys.erase': 'throw' };
  const calls: string[] = [];
  const exec = {
    planSteps: (_m: KillSwitchMode) => APP_KILL_SWITCH_STEPS,
    performStep: async (id: string) => {
      calls.push(id);
      const o = outcomes[id] ?? 'erased';
      if (o === 'throw') throw new Error('x'.repeat(300));
      return { status: o as StepStatus, details: o === 'skipped' ? 'no bluetooth here' : undefined };
    },
  };
  const first = await runKillSwitch(exec, null, { scope: 'application', mode: 'local-only' });
  const callsFirst = [...calls];
  calls.length = 0;
  outcomes['keys.erase'] = 'erased';
  const resumed = await runKillSwitch(exec, null, { scope: 'application', mode: 'local-only', existingReport: { ...first, steps: first.steps } });
  return {
    first: { steps: first.steps, calls: callsFirst, summary: summarizeReport(first) },
    resumed: { steps: resumed.steps, calls: [...calls], summary: summarizeReport(resumed) },
  };
}
const killswitch = { app: APP_KILL_SWITCH_STEPS, conversation: CONVERSATION_KILL_SWITCH_STEPS, summaries, run: await run() };

// ---- manual connection codes
const signal = createManualSignal({
  kind: 'offer', conversationId: 'duo', fromUid: 'uid1', fromDeviceId: 'dev1', publicKeyJwk: jwk, dhJwk: dh,
  identityProof: 'P'.repeat(48), sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n', nonce: 'N'.repeat(24), createdAt: 1700000000000,
});
const good = encodeManualSignal(signal);
const mutate = (patch: Record<string, unknown>) => encodeManualSignal({ ...signal, ...patch } as never);
const manual = {
  signal,
  encoded: good,
  decode: [
    ['good', good, 'duo'],
    ['wrong conversation', good, 'other'],
    ['not a code', 'hello', 'duo'],
    ['padded with spaces', `  ${good}  `, 'duo'],
    ['bad base64', 'DUO1:***', 'duo'],
    ['bad json', 'DUO1:' + Buffer.from('{nope').toString('base64url'), 'duo'],
    ['wrong version', mutate({ v: 9 }), 'duo'],
    ['bad kind', mutate({ kind: 'x' }), 'duo'],
    ['no sender', mutate({ fromUid: '' }), 'duo'],
    ['no device', mutate({ fromDeviceId: '' }), 'duo'],
    ['bad signing key', mutate({ publicKeyJwk: { ...jwk, y: 'z' } }), 'duo'],
    ['short proof', mutate({ identityProof: 'short' }), 'duo'],
    ['short sdp', mutate({ sdp: 'v=0' }), 'duo'],
    ['sdp without v=0', mutate({ sdp: 'x'.repeat(40) }), 'duo'],
    ['short nonce', mutate({ nonce: 'abc' }), 'duo'],
    ['bad time', mutate({ createdAt: 0 }), 'duo'],
  ].map(([name, code, conv]) => ({ name, code, conv, result: decodeManualSignal(code as string, conv as string) })),
};

// ---- nostr events (BIP-340 Schnorr, throwaway keys)
const enc = new TextEncoder();
const eventId = (e: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }) =>
  bytesToHex(sha256(enc.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
const blob = { v: 1, to: 'b'.repeat(64), from: 'a'.repeat(64), epk: { kty: 'EC', crv: 'P-256', x, y }, iv: 'I'.repeat(16), ct: 'C'.repeat(30), sig: 'S'.repeat(86) };
const sk = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const base = { pubkey: bytesToHex(schnorr.getPublicKey(sk)), created_at: 1700000000, kind: 21733, tags: [['t', 'mailbox1'], ['d', 'id-1'], ['expiration', '1700000120']], content: encodeBlob(blob as never) };
const id = eventId(base);
const event = { ...base, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk, new Uint8Array(32))) };
const tampered = { ...event, content: event.content + 'A' };
const nostr = {
  blob,
  event,
  tampered,
  expectId: id,
  verify: [event, tampered, { ...event, id: '0'.repeat(64) }, { ...event, sig: '0'.repeat(128) }].map((e) => {
    let ok = false;
    try { ok = eventId(e) === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey)); } catch { ok = false; }
    return { event: e, ok };
  }),
};

writeFileSync(new URL('../../../docs/misc-vectors.json', import.meta.url), JSON.stringify({ comment: 'Generated by packages/protocol/scripts/gen-misc-vectors.ts', pairing, killswitch, manual, nostr }, null, 1));
console.log('wrote docs/misc-vectors.json');
