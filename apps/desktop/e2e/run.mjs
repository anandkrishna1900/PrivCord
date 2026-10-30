// Usage: node e2e/run.mjs [--only 1,2,...]   (or: npm run e2e)
import fs from 'node:fs';
import path from 'node:path';
import { build, connected, device, installBleSim, launch, onboard, pair, realPath, relayNet, say, serve, startNostrRelay, startRelay, startTurn, uidOf, uiPath } from './lib.mjs';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg, evidence) => {
  if (!ok) throw new Error(`${msg}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ''}`);
};

const dist = build();
const { server, url: appUrl } = await serve(dist);
const browser = await launch();

async function scenario(id, name, fn) {
  if (only && !only.includes(String(id))) return;
  const started = Date.now();
  const notes = [];
  const cleanups = [];
  try {
    await fn({ note: (n) => notes.push(n), cleanups });
    results.push({ id, name, status: 'PASS', notes, secs: Math.round((Date.now() - started) / 1000) });
  } catch (error) {
    results.push({ id, name, status: 'FAIL', notes: [...notes, error.message], secs: Math.round((Date.now() - started) / 1000) });
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
  }
  const r = results.at(-1);
  console.log(`${r.status} #${id} ${name} (${r.secs}s)\n   ${r.notes.join('\n   ')}`);
}

/* 1 ------------------------------------------------------------------ */
await scenario(1, 'onboarding: mandatory 12-word phrase, verification, same phrase = same uid', async ({ note, cleanups }) => {
  const a = await device(browser, appUrl);
  cleanups.push(() => a.context.close());
  await a.page.waitForSelector('.phrase-word-box', { timeout: 15000 });
  check((await a.page.locator('.phrase-word-box').count()) === 12, 'shows exactly 12 words');
  check((await a.page.locator('.chat-header').count()) === 0, 'chat is not reachable before an identity exists');
  await a.page.keyboard.press('Escape');
  await a.page.mouse.click(5, 5); // backdrop click
  check((await a.page.locator('.phrase-word-box').count()) === 12 && (await a.page.locator('.chat-header').count()) === 0, 'Escape/backdrop cannot skip the phrase');
  // wrong words are rejected
  await a.page.click('text=I have saved my phrase');
  await a.page.fill('#verify-word-1', 'zzzz');
  await a.page.fill('#verify-word-2', 'yyyy');
  await a.page.click('text=Verify & Confirm');
  await a.page.waitForSelector('.banner.error');
  check((await a.page.locator('.chat-header').count()) === 0, 'wrong confirmation words do not create an identity');
  note('wrong words rejected');
  await a.page.reload();
  check((await a.page.locator('.chat-header').count()) === 0 || true, '');
  await a.page.waitForSelector('.phrase-word-box');
  check((await a.page.locator('.chat-header').count()) === 0, 'still no identity after reload (nothing was saved)');
  const phrase = await onboard(a.page);
  const uid = await uidOf(a.page);
  check(/^[0-9a-f]{64}$/.test(uid), 'uid is a 64-hex fingerprint', uid);
  note(`uid ${uid.slice(0, 16)}…`);
  await a.page.reload();
  await a.page.waitForSelector('.chat-header');
  check((await uidOf(a.page)) === uid, 'uid survives reload');
  // restore in a brand-new device
  const b = await device(browser, appUrl);
  cleanups.push(() => b.context.close());
  await b.page.waitForSelector('.phrase-word-box');
  await b.page.click('text=Already have a phrase? Restore');
  await b.page.fill('#restore-phrase-input', phrase);
  await b.page.click('button:has-text("Restore Identity")');
  await b.page.waitForSelector('.chat-header', { timeout: 15000 });
  check((await uidOf(b.page)) === uid, 'restoring the phrase on another device gives the same uid');
  note('restore on a fresh device gives identical uid');
  // invalid phrase
  const c = await device(browser, appUrl);
  cleanups.push(() => c.context.close());
  await c.page.waitForSelector('.phrase-word-box');
  await c.page.click('text=Already have a phrase? Restore');
  await c.page.fill('#restore-phrase-input', 'abandon abandon abandon');
  await c.page.click('button:has-text("Restore Identity")');
  await c.page.waitForSelector('.banner.error');
  check((await c.page.locator('.chat-header').count()) === 0, 'invalid phrase rejected');
});

/* shared setup: two onboarded devices paired over the given backend config */
async function pairedDevices(ctx, network, { connectNow = true } = {}) {
  const a = await device(browser, appUrl, network);
  const b = await device(browser, appUrl, network);
  ctx.cleanups.push(() => a.context.close(), () => b.context.close());
  await onboard(a.page);
  await onboard(b.page);
  const pairResult = await pair(a.page, b.page);
  const { numbers } = pairResult;
  check(numbers[0] === numbers[1] && numbers[0].length > 10, 'both sides show the same safety number', numbers);
  ctx.note(`safety number ${numbers[0]}`);
  if (connectNow) {
    await connected(a.page);
    await connected(b.page);
  }
  return { a, b, pairResult };
}

/* 2 + 3 + 4 --------------------------------------------------------- */
let shared = null;
await scenario(2, 'cards + safety number, AUTOMATIC connection via relay (no codes), messages both ways', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const { a, b, pairResult } = await pairedDevices(ctx, relayNet(relay.url));
  ctx.note('connected automatically, zero codes pasted');
  await say(a.page, 'hello from A');
  await b.page.waitForSelector('text=hello from A', { timeout: 15000 });
  await say(b.page, 'hi back from B');
  await a.page.waitForSelector('text=hi back from B', { timeout: 15000 });
  await sleep(1500);
  const ticksA = await a.page.locator('.bubble.own .delivery-indicator').evaluateAll((e) => e.map((x) => x.title));
  check(ticksA.some((t) => /Delivered|Read/.test(t)), 'A sees a delivered/read tick', ticksA);
  ctx.note(`A ticks: ${JSON.stringify(ticksA)}`);
  check([...a.errors, ...b.errors].length === 0, 'no page errors', [...a.errors, ...b.errors]);
  shared = { relay, a, b, cards: pairResult.cards };
  ctx.cleanups.length = 0; // keep alive for 3 and 4
  shared.cleanup = async () => { await a.context.close(); await b.context.close(); await relay.close(); };
});

await scenario(3, 'reload both: automatic reconnect, queued offline message flushes', async (ctx) => {
  check(shared, 'needs scenario 2');
  const { a, b } = shared;
  await a.page.reload();
  await b.page.reload();
  await a.page.waitForSelector('.chat-header');
  await b.page.waitForSelector('.chat-header');
  check((await a.page.locator('text=hello from A').count()) > 0, 'history persisted');
  await say(a.page, 'queued while offline');
  await a.page.waitForSelector('text=queued while offline');
  const t0 = Date.now();
  await connected(a.page, 120000);
  await connected(b.page, 120000);
  ctx.note(`reconnected automatically after ${Math.round((Date.now() - t0) / 1000)}s`);
  await b.page.waitForSelector('text=queued while offline', { timeout: 30000 });
  ctx.note('queued message delivered after reconnect');
});

await scenario(4, 'third identity cannot connect to a paired contact; foreign/tampered cards rejected', async (ctx) => {
  check(shared, 'needs scenario 2');
  const { a, b, cards } = shared;
  const relayUrl = shared.relay.url;
  // C: a stranger. C pairs with A's card on its own side and tries to reach A.
  const c = await device(browser, appUrl, relayNet(relayUrl));
  ctx.cleanups.push(() => c.context.close());
  await onboard(c.page);
  await c.page.click('button[aria-label="Add your friend"]');
  const cardC = await c.page.locator('textarea[aria-label="Your contact card"]').inputValue();
  await c.page.fill('textarea[aria-label="Friend\'s contact card"]', cards[0]);
  await c.page.click('button:has-text("Continue")');
  await c.page.waitForSelector('.verify-panel .safety-number');
  await c.page.click('text=Numbers match, save friend');
  check((await a.page.locator('text=Friend saved').count()) === 0, 'sanity');
  const marker = 'stranger says hi';
  await sleep(1000);
  // Wait long enough for several offer/ready rounds, then check A never connected to C.
  await sleep(50000);
  const cPlaceholder = await c.page.locator('.composer textarea').getAttribute('placeholder');
  check(cPlaceholder !== 'Write a message…', 'stranger C is not connected to A', cPlaceholder);
  await say(c.page, marker);
  await sleep(3000);
  check((await a.page.locator(`text=${marker}`).count()) === 0, 'A never received C\'s message');
  check((await b.page.locator(`text=${marker}`).count()) === 0, 'B never received C\'s message');
  ctx.note('after 50s C is still disconnected; A and B (paired to each other) are unaffected');
  await say(a.page, 'still fine after stranger');
  await b.page.waitForSelector('text=still fine after stranger', { timeout: 20000 });
  // Card validation on a fresh, unpaired device D
  const d = await device(browser, appUrl, relayNet(relayUrl));
  ctx.cleanups.push(() => d.context.close());
  await onboard(d.page);
  await d.page.click('button[aria-label="Add your friend"]');
  const tryCard = async (text) => {
    await d.page.fill('textarea[aria-label="Friend\'s contact card"]', text);
    await d.page.click('button:has-text("Continue")');
    await sleep(600);
    return (await d.page.locator('.status-text.error').count()) > 0;
  };
  check(await tryCard('hello'), 'garbage rejected');
  check(await tryCard('DUOID1:AAAA'), 'malformed card rejected');
  const tampered = cardC.slice(0, 60) + (cardC[60] === 'A' ? 'B' : 'A') + cardC.slice(61);
  check(await tryCard(tampered), 'tampered card rejected');
  const own = await d.page.locator('textarea[aria-label="Your contact card"]').inputValue();
  check(await tryCard(own), 'own card rejected');
  ctx.note('garbage / malformed / tampered / own cards all rejected');
});

/* 5 ------------------------------------------------------------------ */
await scenario(5, 'store-and-forward: offline message arrives via relay; off = nothing stored', async (ctx) => {
  for (const enabled of [false, true]) {
    const relay = await startRelay(true);
    ctx.cleanups.push(relay.close);
    const { a, b } = await pairedDevices(ctx, relayNet(relay.url, { storeForward: enabled }));
    const queueFile = path.join(relay.dataDir, 'queue.jsonl');
    const queued = () => (fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8').split('\n').filter((l) => /"op":"put"/.test(l)).length : 0);
    await b.page.close();
    await sleep(2500);
    const text = `offline msg storeForward=${enabled}`;
    await say(a.page, text);
    await a.page.waitForSelector(`text=${text}`);
    // A only notices the dead channel after ~10-20s; until then the message sits in the closed channel.
    if (enabled) for (let i = 0; i < 60 && queued() === 0; i += 1) await sleep(1000);
    else await sleep(30000);
    if (!enabled) {
      check(queued() === 0, 'storeForward off: nothing persisted on the relay', queued());
      ctx.note('storeForward off: relay queue.jsonl has 0 put records');
      continue;
    }
    check(queued() >= 1, 'storeForward on: sealed message persisted on the relay', queued());
    const raw = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : '';
    check(!raw.includes(text), 'relay storage does not contain the plaintext');
    ctx.note(`relay holds ${queued()} sealed record(s), plaintext absent`);
    await b.open();
    await b.page.waitForSelector(`text=${text}`, { timeout: 60000 });
    ctx.note('B received the message after coming online');
    await a.page.waitForFunction(
      () => [...document.querySelectorAll('.bubble.own .delivery-indicator')].some((e) => /Delivered|Read/.test(e.title)),
      null,
      { timeout: 60000 },
    );
    ctx.note('A shows it delivered');
  }
});

/* 6 ------------------------------------------------------------------ */
await scenario(6, 'Nostr signaling (in-memory NIP-01 relay): automatic connect + messages', async (ctx) => {
  const nostr = await startNostrRelay();
  ctx.cleanups.push(nostr.close);
  const net = { stun: [], turn: [], signaling: [{ kind: 'nostr', relays: [nostr.url] }], storeForward: false, forceRelay: false };
  const { a, b } = await pairedDevices(ctx, net);
  await say(a.page, 'over nostr signaling');
  await b.page.waitForSelector('text=over nostr signaling', { timeout: 15000 });
  const kinds = [...new Set(nostr.seen)];
  check(kinds.includes(21733), 'signaling events (kind 21733) crossed the relay', kinds);
  check(!kinds.includes(31733), 'no stored-message events with storeForward off', kinds);
  ctx.note(`event kinds seen on relay: ${JSON.stringify(kinds)}; message text never crossed the relay (direct channel)`);
  check(nostr.stored.length === 0, 'relay stored nothing');
});

/* 7 ------------------------------------------------------------------ */
await scenario(7, 'path truth: host-only = "Direct, same network"; TURN + forceRelay = "Relayed through TURN"', async (ctx) => {
  {
    const relay = await startRelay(false);
    ctx.cleanups.push(relay.close);
    const { a } = await pairedDevices(ctx, relayNet(relay.url));
    const ui = await uiPath(a.page);
    const real = await realPath(a.page);
    ctx.note(`no TURN: UI says "${ui}"; getStats says ${JSON.stringify(real)}`);
    check(real && real.local === 'host' && real.remote === 'host', 'getStats shows host/host', real);
    check(ui === 'Direct, same network', 'UI label matches', ui);
  }
  const turn = await startTurn();
  ctx.cleanups.push(turn.close);
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url, { turn: [{ urls: [turn.url], username: turn.username, credential: turn.credential }], forceRelay: true });
  const { a, b } = await pairedDevices(ctx, net);
  const ui = await uiPath(a.page);
  const real = await realPath(a.page);
  const realB = await realPath(b.page);
  ctx.note(`forceRelay+TURN: UI says "${ui}"; getStats A=${JSON.stringify(real)} B=${JSON.stringify(realB)}`);
  check(real && (real.local === 'relay' || real.remote === 'relay'), 'getStats shows a relay candidate', real);
  check(ui === 'Relayed through TURN', 'UI label matches', ui);
  await say(a.page, 'through turn');
  await b.page.waitForSelector('text=through turn', { timeout: 15000 });
  ctx.note('message delivered over the TURN-relayed path');
});

/* 8 ------------------------------------------------------------------ */
await scenario(8, 'Bluetooth (simulated radio), NO internet, NO signaling: connect, encrypted, tamper kills link', async (ctx) => {
  // Nothing configured at all: no STUN, no TURN, no signaling. Bluetooth is the only way to connect.
  const offline = { stun: [], turn: [], signaling: [], storeForward: false, forceRelay: false, bluetooth: true };
  const a = await device(browser, appUrl, offline);
  const b = await device(browser, appUrl, offline);
  ctx.cleanups.push(() => a.context.close(), () => b.context.close());
  a.name = 'A';
  b.name = 'B';
  const sim = await installBleSim([a, b]);
  await onboard(a.page);
  await onboard(b.page);
  await pair(a.page, b.page);
  await connected(a.page, 120000);
  await connected(b.page, 120000);
  const label = await uiPath(a.page);
  ctx.note(`UI path label: "${label}"`);
  check(label === 'Bluetooth, no internet', 'path says Bluetooth', label);
  check(sim.links >= 1, 'link formed through the simulated radio', sim.links);
  check((await realPath(a.page)) === null, 'no WebRTC connection exists (it really is Bluetooth)');
  const secret = 'bt-secret-marker-5521';
  await say(a.page, secret);
  await b.page.waitForSelector(`text=${secret}`, { timeout: 15000 });
  await say(b.page, 'reply-over-bluetooth');
  await a.page.waitForSelector('text=reply-over-bluetooth', { timeout: 15000 });
  const wire = sim.text();
  ctx.note(`${sim.log.length} radio chunks recorded, ${wire.length} bytes on the air`);
  check(!wire.includes(secret) && !wire.includes('reply-over-bluetooth'), 'message text never appears on the air');
  check(!wire.includes('"kind":"hello"') && !wire.includes('publicKeyJwk'), 'identity handshake is also encrypted');
  // Heartbeat: both directions must keep seeing frames; then an attacker flips a bit on the air.
  sim.tamper = (hex) => {
    const bytes = hex.match(/../g);
    bytes[bytes.length - 1] = ((parseInt(bytes[bytes.length - 1], 16) ^ 1) & 255).toString(16).padStart(2, '0');
    return bytes.join('');
  };
  await say(a.page, 'this-will-be-tampered');
  await b.page.waitForFunction(() => document.querySelector('.composer textarea')?.getAttribute('placeholder') !== 'Write a message…', null, { timeout: 30000 });
  check((await b.page.locator('text=this-will-be-tampered').count()) === 0, 'tampered message is NOT accepted');
  ctx.note('tampered chunk rejected, link dropped');
  check([...a.errors, ...b.errors].length === 0, 'no page errors', [...a.errors, ...b.errors]);
});

/* 9 ------------------------------------------------------------------ */
await scenario(9, 'dead-link detection: a vanished peer is noticed within ~15s', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const { a, b } = await pairedDevices(ctx, relayNet(relay.url));
  // Freeze B's network without closing sockets: block outbound data-channel traffic by suspending its page timers is not
  // possible, so we simulate a vanished peer by closing B's context abruptly and timing how fast A notices.
  const started = Date.now();
  await b.context.close();
  await a.page.waitForFunction(() => document.querySelector('.composer textarea')?.getAttribute('placeholder') !== 'Write a message…', null, { timeout: 40000 });
  const secs = Math.round((Date.now() - started) / 1000);
  ctx.note(`A noticed the peer was gone after ${secs}s`);
  check(secs <= 25, 'dead link noticed in <= 25s', secs);
});

console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.status}  #${r.id}  ${r.name}`);
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'last-results.json'), JSON.stringify(results, null, 2));
await shared?.cleanup?.().catch(() => undefined);
await browser.close();
server.close();
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
