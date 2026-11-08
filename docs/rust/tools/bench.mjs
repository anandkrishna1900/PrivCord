// TypeScript baseline for docs/rust/BENCHMARKS.md. Run: node docs/rust/tools/bench.mjs (needs `npm ci` and a built workspace)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { register } = require('node:module');
async function run() {
  const { build } = await import('esbuild');
  const out = new URL('./bench.bundle.mjs', import.meta.url).pathname;
  await build({ entryPoints: [new URL('../../../packages/protocol/src/index.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  const p = await import(out);
  const time = async (label, runs, f) => {
    await f();
    const t = performance.now();
    for (let i = 0; i < runs; i++) await f();
    console.log(`${label}: ${((performance.now() - t) / runs).toFixed(3)} ms per op (${runs} runs)`);
  };
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await time('identity from phrase', 20, () => p.deriveIdentityFromPhrase(phrase, ''));
  const ann = (await p.deriveIdentityFromPhrase(phrase)).identity;
  const bob = (await p.deriveIdentityFromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow')).identity;
  const au = await p.uidFromDh(ann.dhKey.pubJwk), bu = await p.uidFromDh(bob.dhKey.pubJwk);
  const payload = { t: 'msg', id: 'm', text: 'hello hello hello hello hello hello hello hello', at: 1700000000000 };
  await time('seal a message', 200, () => p.seal({ payload, fromUid: au, toUid: bu, toDh: bob.dhKey.pubJwk, signPriv: ann.signKey.privJwk }));
  const blob = await p.seal({ payload, fromUid: au, toUid: bu, toDh: bob.dhKey.pubJwk, signPriv: ann.signKey.privJwk });
  await time('open a message', 200, () => p.open({ blob, ownUid: bu, ownDhPriv: bob.dhKey.privJwk, senderSign: ann.signKey.pubJwk, senderUid: au }));
  const a = await p.SecureChannel.create({ ownUid: au, peerUid: bu, signPriv: ann.signKey.privJwk, peerSign: bob.signKey.pubJwk });
  const b = await p.SecureChannel.create({ ownUid: bu, peerUid: au, signPriv: bob.signKey.privJwk, peerSign: ann.signKey.pubJwk });
  const [ha, hb] = [await a.hello(), await b.hello()];
  await a.accept(hb); await b.accept(ha);
  await time('secure-channel frame encrypt + decrypt', 2000, async () => b.decrypt(await a.encrypt(payload)));
  await time('derive invite', 5, () => p.deriveInvite(['apple', 'river', 'tiger', 'moon', 'cloud', 'seven']));
}
run();
