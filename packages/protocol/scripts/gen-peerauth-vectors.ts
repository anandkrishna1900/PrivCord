/**
 * Generates docs/peerauth-vectors.json: a full legacy WebRTC handshake transcript made by the TypeScript implementation
 * (hello, auth_proof, auth_ok) between two fixed test identities, with fixed device ids and nonces, so the Rust port can
 * be checked against it. Run: `npx tsx scripts/gen-peerauth-vectors.ts` from packages/protocol.
 * The phrases are public BIP-39 test vectors; never use them as real identities.
 */
import { writeFileSync } from 'node:fs';
import {
  authChallenge,
  deriveIdentityFromPhrase,
  ecdsaSign,
  parsePeerFrame,
  toB64Url,
  uidFromKeys,
} from '../src';

const PHRASES = {
  ann: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  bob: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
};
const CONTEXT = 'duo';

async function side(name: 'ann' | 'bob', deviceId: string, nonce: string) {
  const { identity } = await deriveIdentityFromPhrase(PHRASES[name]);
  const uid = await uidFromKeys(identity.signKey.pubJwk, identity.dhKey.pubJwk);
  return { name, deviceId, nonce, identity, uid };
}

async function main() {
  const ann = await side('ann', 'device-ann', 'a1'.repeat(24));
  const bob = await side('bob', 'device-bob', 'b2'.repeat(24));
  const hello = (s: typeof ann) => ({
    v: 1, kind: 'hello', uid: s.uid, deviceId: s.deviceId,
    publicKeyJwk: s.identity.signKey.pubJwk, dhJwk: s.identity.dhKey.pubJwk,
    identityProof: s.identity.identityProof, nonce: s.nonce,
  });
  const proof = async (me: typeof ann, other: typeof ann) => {
    const challenge = authChallenge({ conversationId: CONTEXT, uid: me.uid, deviceId: me.deviceId, nonceSelf: me.nonce, noncePeer: other.nonce });
    const signature = toB64Url(await ecdsaSign(me.identity.signKey.privJwk, new TextEncoder().encode(challenge)));
    return { challenge, frame: { v: 1, kind: 'auth_proof', uid: me.uid, signature } };
  };
  const annProof = await proof(ann, bob);
  const bobProof = await proof(bob, ann);
  const frames = {
    annHello: hello(ann),
    bobHello: hello(bob),
    annProof: annProof.frame,
    bobProof: bobProof.frame,
    annOk: { v: 1, kind: 'auth_ok', uid: ann.uid },
    bobOk: { v: 1, kind: 'auth_ok', uid: bob.uid },
  };
  // Every frame must parse in TypeScript, and a few liveness and receipt frames are included for the parser.
  for (const f of Object.values(frames)) if (!parsePeerFrame(f)) throw new Error('frame did not parse');
  const other = [
    { v: 1, kind: 'ping', at: 1700000000123 },
    { v: 1, kind: 'pong', at: 1700000000123 },
    { v: 1, kind: 'ack', messageId: 'm-1', state: 'DELIVERED', at: 5 },
    { v: 1, kind: 'ack', messageId: 'm-1', state: 'READ', at: 6 },
    { v: 1, kind: 'read', lastReadMessageId: 'm-9', at: 7 },
  ];
  const out = {
    generatedBy: 'packages/protocol/scripts/gen-peerauth-vectors.ts',
    context: CONTEXT,
    ann: { phrase: PHRASES.ann, uid: ann.uid, deviceId: ann.deviceId, nonce: ann.nonce },
    bob: { phrase: PHRASES.bob, uid: bob.uid, deviceId: bob.deviceId, nonce: bob.nonce },
    frames,
    challenges: { ann: annProof.challenge, bob: bobProof.challenge },
    other: other.map((f) => ({ frame: f, parsed: parsePeerFrame(f) })),
    rejected: [
      { label: 'short nonce', frame: { ...hello(ann), nonce: 'short' } },
      { label: 'no device id', frame: { ...hello(ann), deviceId: '' } },
      { label: 'short proof', frame: { ...hello(ann), identityProof: 'x'.repeat(10) } },
      { label: 'bad ack state', frame: { v: 1, kind: 'ack', messageId: 'm', state: 'SENT', at: 1 } },
    ].map((r) => ({ ...r, parsed: parsePeerFrame(r.frame) })),
  };
  writeFileSync(new URL('../../../docs/peerauth-vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote docs/peerauth-vectors.json');
}
main();
