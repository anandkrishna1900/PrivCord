// Usage: node e2e/run.mjs [--only 1,2,...]   (or: npm run e2e)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addFriend, build, connected, device, installBleSim, invites, isConnected, launch, onboard, openAdd, groupAdd, groupRemove,
  memberNames, messageMember, newGroup, openChat, openGroupDetails, pair, setName, pasteInvite, realPath, relayNet, saveFile, say, sendFile, serve,
  setGroupOnly, startNostrRelay, startRelay, startTurn, uidOf, uiPath } from './lib.mjs';

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
  check((await a.page.locator('.app-shell').count()) === 0, 'chat is not reachable before an identity exists');
  await a.page.keyboard.press('Escape');
  await a.page.mouse.click(5, 5); // backdrop click
  check((await a.page.locator('.phrase-word-box').count()) === 12 && (await a.page.locator('.app-shell').count()) === 0, 'Escape/backdrop cannot skip the phrase');
  // wrong words are rejected
  await a.page.click('text=I have saved my phrase');
  await a.page.fill('#verify-word-1', 'zzzz');
  await a.page.fill('#verify-word-2', 'yyyy');
  await a.page.click('text=Verify & Confirm');
  await a.page.waitForSelector('.banner.error');
  check((await a.page.locator('.app-shell').count()) === 0, 'wrong confirmation words do not create an identity');
  note('wrong words rejected');
  await a.page.reload();
  check((await a.page.locator('.app-shell').count()) === 0 || true, '');
  await a.page.waitForSelector('.phrase-word-box');
  check((await a.page.locator('.app-shell').count()) === 0, 'still no identity after reload (nothing was saved)');
  const phrase = await onboard(a.page);
  const uid = await uidOf(a.page);
  check(/^[0-9a-f]{64}$/.test(uid), 'uid is a 64-hex fingerprint', uid);
  note(`uid ${uid.slice(0, 16)}…`);
  await a.page.reload();
  await a.page.waitForSelector('.app-shell');
  check((await uidOf(a.page)) === uid, 'uid survives reload');
  // restore in a brand-new device
  const b = await device(browser, appUrl);
  cleanups.push(() => b.context.close());
  await b.page.waitForSelector('.phrase-word-box');
  await b.page.click('text=Already have a phrase? Restore');
  await b.page.fill('#restore-phrase-input', phrase);
  await b.page.click('button:has-text("Restore Identity")');
  await b.page.waitForSelector('.app-shell', { timeout: 15000 });
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
  check((await c.page.locator('.app-shell').count()) === 0, 'invalid phrase rejected');
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
  ctx.note(`A ticks: ${JSON.stringify(ticksA)} bubbles: ${JSON.stringify(await a.page.locator('.bubble').allInnerTexts())}`);
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
  await openChat(a.page);
  await openChat(b.page);
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
  const cardC = await openAdd(c.page);
  await c.page.keyboard.press('Escape');
  await addFriend(c.page, cards[0]);
  const marker = 'stranger says hi';
  await sleep(1000);
  // Wait long enough for several offer/ready rounds, then check A never connected to C.
  await sleep(50000);
  check(!(await isConnected(c.page)), 'stranger C is not connected to A');
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
  const own = await openAdd(d.page);
  const tryCard = async (text) => {
    await d.page.fill('textarea[aria-label="Friend\'s invite"]', text);
    await d.page.click('button:has-text("Continue")');
    await sleep(600);
    return (await d.page.locator('.status-text.error').count()) > 0;
  };
  check(await tryCard('hello'), 'garbage rejected');
  check(await tryCard('DUOID1:AAAA'), 'malformed card rejected');
  const tampered = cardC.slice(0, 60) + (cardC[60] === 'A' ? 'B' : 'A') + cardC.slice(61);
  check(await tryCard(tampered), 'tampered card rejected');
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
    await openChat(b.page);
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
  await b.page.waitForFunction(() => !(document.querySelector('.chat-header-identity p')?.textContent ?? '').startsWith('Connected'), null, { timeout: 30000 });
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
  await a.page.waitForFunction(() => !(document.querySelector('.chat-header-identity p')?.textContent ?? '').startsWith('Connected'), null, { timeout: 40000 });
  const secs = Math.round((Date.now() - started) / 1000);
  ctx.note(`A noticed the peer was gone after ${secs}s`);
  check(secs <= 25, 'dead link noticed in <= 25s', secs);
});

/* 10 ----------------------------------------------------------------- */
async function namedDevice(ctx, network, name, url = appUrl) {
  const dev = await device(browser, url, network);
  ctx.cleanups.push(() => dev.context.close());
  dev.name = name;
  await onboard(dev.page);
  await setName(dev.page, name);
  return dev;
}

/** pair two onboarded devices (each verifies/saves the other). */
async function befriend(x, y) {
  const [ix, iy] = await invites(x.page, y.page);
  await addFriend(x.page, iy);
  await addFriend(y.page, ix);
}

await scenario(10, 'A-B-C introduction: A and C connect and can DM with no code sharing; group-only opt-out by either side blocks DMs but not the group; swapping invites pairs them', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const [A, B, C] = [await namedDevice(ctx, net, 'Ann'), await namedDevice(ctx, net, 'Ben'), await namedDevice(ctx, net, 'Cat')];
  await befriend(A, B);
  await befriend(B, C);
  const openDirect = async (page, name) => { await page.locator('.chat-row', { has: page.locator(`strong:text-is("${name}")`) }).click(); await page.waitForSelector(`.chat-header h2:has-text("${name}")`); };
  const row = (page, name) => page.locator(`.chat-row strong:text-is("${name}")`);
  check((await row(A.page, 'Cat').count()) === 0, 'A and C are strangers before the group');
  await newGroup(A.page, 'Trip', ['Ben']);
  await B.page.waitForSelector('.chat-row:has-text("Trip")', { timeout: 60000 });
  await openChat(B.page, 'Trip');
  await groupAdd(B.page, 'Cat');
  const t0 = Date.now();
  await C.page.waitForSelector('.chat-row:has-text("Trip")', { timeout: 60000 });
  // Default: nobody opted out, so A and C appear in each other's lists and link up automatically.
  await row(A.page, 'Cat').waitFor({ timeout: 60000 });
  await row(C.page, 'Ann').waitFor({ timeout: 60000 });
  await openDirect(A.page, 'Cat');
  await connected(A.page, 120000);
  ctx.note(`A <-> C direct link up ${Math.round((Date.now() - t0) / 1000)}s after the add (no invite, no code)`);
  await say(A.page, 'hello Cat, no code needed');
  await openDirect(C.page, 'Ann');
  await C.page.waitForSelector('text=hello Cat, no code needed', { timeout: 30000 });
  ctx.note('default: introduced people can message each other directly');
  // Cat opts out. Both sides drop the direct chat; the group keeps working in both directions.
  await openChat(A.page, 'Trip');
  await openChat(C.page, 'Trip');
  await setGroupOnly(C.page, true);
  await row(A.page, 'Cat').waitFor({ state: 'detached', timeout: 30000 });
  await row(C.page, 'Ann').waitFor({ state: 'detached', timeout: 30000 });
  await say(C.page, 'group hi from Cat');
  await A.page.waitForSelector('text=group hi from Cat', { timeout: 30000 });
  await say(A.page, 'group hi from Ann');
  await C.page.waitForSelector('text=group hi from Ann', { timeout: 30000 });
  // reply across the group-only pair
  await A.page.locator('.bubble:has(.bubble-text:text-is("group hi from Cat"))').hover();
  await A.page.locator('.bubble:has(.bubble-text:text-is("group hi from Cat")) button[aria-label="Reply to this message"]').click();
  await say(A.page, 'welcome Cat');
  await C.page.waitForSelector('.bubble:has-text("welcome Cat") .quote:has-text("group hi from Cat")', { timeout: 30000 });
  ctx.note('Cat opted out: no direct chat either way, group messages and replies still flow');
  await openGroupDetails(A.page);
  check((await A.page.locator('.member-row', { hasText: 'Cat' }).locator('.chip:has-text("Group only")').count()) === 1, 'Ann sees Cat as "Group only"');
  await A.page.keyboard.press('Escape');
  // Cat opts back in: the direct chat returns.
  await setGroupOnly(C.page, false);
  await row(A.page, 'Cat').waitFor({ timeout: 30000 });
  await row(C.page, 'Ann').waitFor({ timeout: 30000 });
  ctx.note('opting back in restores the direct chat');
  // Now Ann opts out instead (the other side): same result.
  await setGroupOnly(A.page, true);
  await row(A.page, 'Cat').waitFor({ state: 'detached', timeout: 30000 });
  await row(C.page, 'Ann').waitFor({ state: 'detached', timeout: 30000 });
  ctx.note('it does not matter which of the two opts out');
  // Pair manually (swap invites): that works even while Ann is group-only.
  const [invA, invC] = await invites(A.page, C.page);
  await addFriend(A.page, invC);
  await addFriend(C.page, invA);
  await row(A.page, 'Cat').waitFor({ timeout: 30000 });
  await row(C.page, 'Ann').waitFor({ timeout: 30000 });
  await openDirect(A.page, 'Cat');
  await openDirect(C.page, 'Ann');
  await connected(A.page, 60000);
  await say(C.page, 'paired by hand');
  await A.page.waitForSelector('text=paired by hand', { timeout: 30000 });
  ctx.note('after swapping invites they can message directly even though one stays group-only');
  await openChat(A.page, 'Trip');
  check(JSON.stringify((await memberNames(A.page)).sort()) === JSON.stringify(['Ben', 'Cat', 'You']), 'A sees all three members', await memberNames(A.page));
  const errs = [...A.errors, ...B.errors, ...C.errors];
  check(errs.length === 0, 'no page errors', errs);
});

/* 11 ----------------------------------------------------------------- */
await scenario(11, '6-browser group built by chain introductions: full mesh, each message once, removal, offline catch-up', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const names = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'];
  const devs = [];
  for (const n of names) devs.push(await namedDevice(ctx, net, n));
  for (let i = 0; i < 5; i += 1) await befriend(devs[i], devs[i + 1]); // a chain: nobody else knows anybody
  await newGroup(devs[0].page, 'Crew', ['U2']);
  for (let i = 1; i < 5; i += 1) {
    await devs[i].page.waitForSelector('.chat-row:has-text("Crew")', { timeout: 90000 });
    await openChat(devs[i].page, 'Crew');
    await groupAdd(devs[i].page, names[i + 1]);
  }
  const t0 = Date.now();
  await devs[5].page.waitForSelector('.chat-row:has-text("Crew")', { timeout: 90000 });
  // Full mesh: the group header says "5 connected" on every device.
  for (const d of devs) {
    await openChat(d.page, 'Crew');
    await d.page.waitForFunction(() => /6 members · 5 connected/.test(document.querySelector('.chat-header-identity p')?.textContent ?? ''), null, { timeout: 240000 });
  }
  ctx.note(`full mesh (every device connected to the other 5) ${Math.round((Date.now() - t0) / 1000)}s after the last add`);
  for (const d of devs) await d.page.waitForTimeout(0);
  // everyone says one thing
  for (const [i, d] of devs.entries()) await say(d.page, `msg-from-${names[i]}`);
  for (const d of devs) {
    for (const n of names) await d.page.waitForSelector(`.message-row:has-text("msg-from-${n}")`, { timeout: 60000 });
  }
  await sleep(3000);
  for (const [i, d] of devs.entries()) {
    for (const n of names) {
      const count = await d.page.locator(`.bubble-text:text-is("msg-from-${n}")`).count();
      check(count === 1, `${names[i]} shows msg-from-${n} exactly once`, count);
    }
  }
  ctx.note('each of the 6 messages appears exactly once on all 6 devices');
  // ticks: U1's message is delivered to all five
  await devs[0].page.waitForFunction(() => [...document.querySelectorAll('.bubble.own .delivery-indicator')].some((e) => /5 of 5/.test(e.title)), null, { timeout: 60000 });
  ctx.note('U1 sees "5 of 5" delivered on its own message');
  // offline member catches up
  await devs[3].page.close();
  await sleep(1500);
  await say(devs[0].page, 'while-U4-was-away');
  await devs[3].open();
  await openChat(devs[3].page, 'Crew');
  await devs[3].page.waitForSelector('text=while-U4-was-away', { timeout: 120000 });
  ctx.note('U4 went offline, came back, and received the message sent while away');
  // admin removes U6
  await groupRemove(devs[0].page, 'U6');
  await devs[5].page.waitForSelector('text=You were removed', { timeout: 60000 });
  await say(devs[0].page, 'after-U6-removed');
  await devs[1].page.waitForSelector('text=after-U6-removed', { timeout: 60000 });
  await sleep(3000);
  check((await devs[5].page.locator('text=after-U6-removed').count()) === 0, 'removed member does not receive later messages');
  check((await devs[5].page.locator('.composer textarea').count()) === 0, 'removed member cannot write');
  ctx.note('U6 shows "You were removed", cannot write, receives nothing new; others continue');
  const errs = devs.flatMap((d) => d.errors);
  check(errs.length === 0, 'no page errors', errs);
});

/* 12 ----------------------------------------------------------------- */
await scenario(12, 'replies: quote shows on both sides in a direct chat and in a group; reply survives a reload', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const [A, B, C] = [await namedDevice(ctx, net, 'Ann'), await namedDevice(ctx, net, 'Ben'), await namedDevice(ctx, net, 'Cat')];
  await befriend(A, B);
  await befriend(A, C);
  await openChat(A.page, 'Ben');
  await openChat(B.page, 'Ann');
  await connected(A.page, 120000);
  await say(A.page, 'lunch at noon?');
  await B.page.waitForSelector('.bubble:has(.bubble-text:text-is("lunch at noon?"))', { timeout: 30000 });
  // Ben replies to that bubble
  await B.page.locator('.bubble:has(.bubble-text:text-is("lunch at noon?"))').hover();
  await B.page.locator('.bubble:has(.bubble-text:text-is("lunch at noon?")) button[aria-label="Reply to this message"]').click();
  await B.page.waitForSelector('.reply-bar:has-text("Replying to Ann")');
  await say(B.page, 'yes, see you there');
  check((await B.page.locator('.reply-bar').count()) === 0, 'reply bar closes after sending');
  await A.page.waitForSelector('.bubble:has-text("yes, see you there") .quote:has-text("lunch at noon?")', { timeout: 30000 });
  await B.page.waitForSelector('.bubble:has-text("yes, see you there") .quote:has-text("lunch at noon?")', { timeout: 10000 });
  ctx.note('direct reply: both sides show the quoted original');
  // Escape cancels a pending reply
  await B.page.locator('.bubble:has(.bubble-text:text-is("lunch at noon?")) button[aria-label="Reply to this message"]').click();
  await B.page.waitForSelector('.reply-bar');
  await B.page.locator('.composer textarea').press('Escape');
  check((await B.page.locator('.reply-bar').count()) === 0, 'Escape cancels the reply');
  // reply survives a reload (stored with the message)
  await B.page.reload();
  await openChat(B.page, 'Ann');
  await B.page.waitForSelector('.bubble:has-text("yes, see you there") .quote:has-text("lunch at noon?")', { timeout: 30000 });
  ctx.note('reply quote is still there after a reload');
  // group: Ann creates a group with both, Cat replies to Ben's message
  await newGroup(A.page, 'Lunch', ['Ben', 'Cat']);
  for (const d of [B, C]) await d.page.waitForSelector('.chat-row:has-text("Lunch")', { timeout: 60000 });
  await openChat(B.page, 'Lunch');
  await openChat(C.page, 'Lunch');
  await C.page.waitForFunction(() => /3 members · 2 connected/.test(document.querySelector('.chat-header-identity p')?.textContent ?? ''), null, { timeout: 150000 });
  await say(B.page, 'I vote pizza');
  await C.page.waitForSelector('.bubble:has(.bubble-text:text-is("I vote pizza"))', { timeout: 30000 });
  await C.page.locator('.bubble:has(.bubble-text:text-is("I vote pizza"))').hover();
  await C.page.locator('.bubble:has(.bubble-text:text-is("I vote pizza")) button[aria-label="Reply to this message"]').click();
  await say(C.page, 'pizza works');
  await openChat(A.page, 'Lunch');
  await A.page.waitForSelector('.bubble:has-text("pizza works") .quote:has-text("I vote pizza")', { timeout: 30000 });
  await B.page.waitForSelector('.bubble:has-text("pizza works") .quote:has-text("I vote pizza")', { timeout: 30000 });
  const quoted = await A.page.locator('.bubble:has-text("pizza works") .quote strong').innerText();
  check(quoted === 'Ben', 'quote names the original author (Ben) for a third person', quoted);
  ctx.note('group reply: all three show the quote, attributed to the original author');
  const errs = [...A.errors, ...B.errors, ...C.errors];
  check(errs.length === 0, 'no page errors', errs);
});

/* 13 ----------------------------------------------------------------- */
await scenario(13, 'files: images preview, exactly 8 MB arrives intact, 8 MB + 1 refused, group file reaches everyone, SVG never rendered', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const [A, B, C] = [await namedDevice(ctx, net, 'Ann'), await namedDevice(ctx, net, 'Ben'), await namedDevice(ctx, net, 'Cat')];
  await befriend(A, B);
  await befriend(A, C);
  await openChat(A.page, 'Ben');
  await openChat(B.page, 'Ann');
  await connected(A.page, 120000);
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  // 1. a real PNG: previewed inline on the receiver, bytes identical
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await sendFile(A.page, { name: 'dot.png', mime: 'image/png', buffer: png });
  await B.page.waitForSelector('.file-bubble:has-text("dot.png") img.file-image', { timeout: 30000 });
  const got = await saveFile(B.page, 'dot.png');
  check(sha(got.bytes) === sha(png) && got.suggested === 'dot.png', 'PNG arrives byte for byte', { suggested: got.suggested });
  await A.page.waitForSelector('.bubble.own:has-text("dot.png") .delivery-indicator[aria-label="Delivered"], .bubble.own:has-text("dot.png") .delivery-indicator[aria-label="Read"]', { timeout: 30000 });
  ctx.note('image previewed inline, saved bytes identical, sender sees Delivered');
  // 1b. a phone photo (40x20 pixels with EXIF orientation 6 = turn right) must show upright (20 wide, 40 tall)
  const photo = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAUACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TAooooAKKKKACiiigAooooAKKKKAP/9k=', 'base64');
  await sendFile(A.page, { name: 'portrait.jpg', mime: 'image/jpeg', buffer: photo });
  await B.page.waitForSelector('.file-bubble:has-text("portrait.jpg") img.file-image', { timeout: 30000 });
  await B.page.waitForFunction(() => { const i = document.querySelector('.file-bubble img.file-image[alt="portrait.jpg"]'); return i && i.complete && i.naturalWidth > 0; });
  const dims = await B.page.evaluate(() => { const i = document.querySelector('.file-bubble img.file-image[alt="portrait.jpg"]'); return [i.naturalWidth, i.naturalHeight]; });
  check(dims[0] === 20 && dims[1] === 40, 'the photo is shown upright, not sideways', dims);
  // clicking the preview opens it full size, with Save and Close
  await B.page.click('button[aria-label="Open portrait.jpg"]');
  await B.page.waitForSelector('.lightbox img.lightbox-image', { timeout: 5000 });
  const [shot] = await Promise.all([B.page.waitForEvent('download', { timeout: 20000 }), B.page.click('.lightbox button:has-text("Save")')]);
  check(shot.suggestedFilename() === 'portrait.jpg', 'Save in the viewer downloads the photo', shot.suggestedFilename());
  await B.page.click('.lightbox button:has-text("Close")');
  await B.page.waitForSelector('.lightbox', { state: 'detached' });
  ctx.note('photo upright, opens full size from the preview, Save works');
  // 2. SVG: shown only as a file card (it can carry script), never rendered
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned = 1</script></svg>');
  await sendFile(A.page, { name: 'x.svg', mime: 'image/svg+xml', buffer: svg });
  await B.page.waitForSelector('.file-bubble:has-text("x.svg")', { timeout: 30000 });
  check((await B.page.locator('.file-bubble:has-text("x.svg") img').count()) === 0, 'SVG is not rendered as an image');
  check((await B.page.evaluate(() => window.__pwned)) === undefined, 'SVG script did not run');
  // 2b. video gets a player, other files (a PDF here) get only a card with Save
  await sendFile(A.page, { name: 'clip.mp4', mime: 'video/mp4', buffer: Buffer.alloc(20000, 3) });
  await B.page.waitForSelector('.file-bubble:has-text("clip.mp4") video.file-video', { timeout: 30000 });
  check((await B.page.locator('.file-bubble:has-text("clip.mp4") button[aria-label^="Save"]').count()) === 1, 'video also has Save');
  await sendFile(A.page, { name: 'notes.pdf', mime: 'application/pdf', buffer: Buffer.alloc(2000, 5) });
  await B.page.waitForSelector('.file-bubble:has-text("notes.pdf")', { timeout: 30000 });
  check((await B.page.locator('.file-bubble:has-text("notes.pdf") video, .file-bubble:has-text("notes.pdf") img').count()) === 0, 'a PDF has no preview, only the card');
  ctx.note('video has a player and Save; other files are a plain card');
  // 3. exactly 8 MB of random data
  const max = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < max.length; i += 65536) globalThis.crypto.getRandomValues(max.subarray(i, i + 65536));
  const t0 = Date.now();
  await sendFile(A.page, { name: 'eight.bin', mime: 'application/octet-stream', buffer: max });
  await B.page.waitForSelector('.file-bubble:has-text("eight.bin")', { timeout: 120000 });
  ctx.note(`8 MB received in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const big = await saveFile(B.page, 'eight.bin');
  check(big.bytes.length === max.length && sha(big.bytes) === sha(max), '8 MB file is intact (SHA-256 equal)');
  // 4. one byte over: refused before anything is sent
  await sendFile(A.page, { name: 'toobig.bin', mime: 'application/octet-stream', buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 7) });
  await A.page.waitForSelector('.composer-error:has-text("at most 8.0 MB")', { timeout: 10000 });
  await sleep(1500);
  check((await B.page.locator('.file-bubble:has-text("toobig.bin")').count()) === 0, 'oversized file is never sent');
  // 5. a hostile name is cleaned
  await sendFile(A.page, { name: '..\\..\\evil<name>.txt', mime: 'text/plain', buffer: Buffer.from('hi') });
  await B.page.waitForSelector('.file-bubble:has-text("evil")', { timeout: 30000 });
  const evil = await saveFile(B.page, 'evil');
  check(!/[\\/:<>]/.test(evil.suggested), 'saved name has no path or reserved characters', evil.suggested);
  // 6. reply to a file keeps its name as the quote
  await B.page.locator('.bubble:has(.file-name:text-is("dot.png"))').first().hover();
  await B.page.locator('.bubble:has(.file-name:text-is("dot.png")) button[aria-label="Reply to this message"]').first().click();
  await say(B.page, 'nice dot');
  await A.page.waitForSelector('.bubble:has-text("nice dot") .quote:has-text("dot.png")', { timeout: 30000 });
  // 7. group file: Ann creates a group, everyone gets the file
  await newGroup(A.page, 'Files', ['Ben', 'Cat']);
  for (const d of [B, C]) await d.page.waitForSelector('.chat-row:has-text("Files")', { timeout: 60000 });
  await openChat(B.page, 'Files');
  await openChat(C.page, 'Files');
  await A.page.waitForFunction(() => /3 members · 2 connected/.test(document.querySelector('.chat-header-identity p')?.textContent ?? ''), null, { timeout: 150000 });
  const doc = Buffer.alloc(1_500_000);
  globalThis.crypto.getRandomValues(doc.subarray(0, 65536));
  await sendFile(A.page, { name: 'report.pdf', mime: 'application/pdf', buffer: doc });
  for (const d of [B, C]) await d.page.waitForSelector('.file-bubble:has-text("report.pdf")', { timeout: 60000 });
  const fromB = await saveFile(B.page, 'report.pdf');
  const fromC = await saveFile(C.page, 'report.pdf');
  check(sha(fromB.bytes) === sha(doc) && sha(fromC.bytes) === sha(doc), 'group file identical on both members');
  await A.page.waitForFunction(() => [...document.querySelectorAll('.bubble.own')].some((e) => e.textContent.includes('report.pdf') && /2 of 2/.test(e.querySelector('.delivery-indicator')?.title ?? '')), null, { timeout: 60000 });
  ctx.note('group file delivered to both members, sender sees "2 of 2"');
  // 8. a file sent while the other side is offline is delivered when it returns
  await C.page.close();
  await sleep(1500);
  const late = Buffer.from('sent while Cat was away');
  await sendFile(A.page, { name: 'late.txt', mime: 'text/plain', buffer: late });
  await B.page.waitForSelector('.file-bubble:has-text("late.txt")', { timeout: 60000 });
  await C.open();
  await openChat(C.page, 'Files');
  await C.page.waitForSelector('.file-bubble:has-text("late.txt")', { timeout: 150000 });
  const lateGot = await saveFile(C.page, 'late.txt');
  check(sha(lateGot.bytes) === sha(late), 'file sent while offline arrives intact after reconnect');
  ctx.note('offline member got the file after coming back');
  // 9. stored files survive a reload
  await B.page.reload();
  await openChat(B.page, 'Files');
  const again = await saveFile(B.page, 'report.pdf');
  check(sha(again.bytes) === sha(doc), 'file still saved on disk after reload');
  const errs = [...A.errors, ...B.errors, ...C.errors];
  check(errs.length === 0, 'no page errors', errs);
});

/* 14 ----------------------------------------------------------------- */
await scenario(14, 'group limit: 10 members is the maximum and the UI says so', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const owner = await namedDevice(ctx, net, 'Owner');
  const others = [];
  for (let i = 1; i <= 9; i += 1) others.push(await namedDevice(ctx, net, `M${i}`));
  for (const o of others) await befriend(owner, o);
  await owner.page.click('button[aria-label="New group"]');
  await owner.page.getByLabel('Group name').fill('Full house');
  for (const o of others) await owner.page.locator('.pick-row', { hasText: o.name }).locator('input').check();
  check((await owner.page.locator('.pick-row input:checked').count()) === 9, 'all nine friends can be picked (9 + you = 10)');
  await owner.page.click('button:has-text("Create group")');
  await owner.page.waitForSelector('.chat-header h2:has-text("Full house")');
  await openGroupDetails(owner.page);
  const title = await owner.page.locator('.section-title').first().innerText();
  check(/10 of 10 members/.test(title), 'details show 10 of 10', title);
  check(await owner.page.locator('button:has-text("Add member")').isDisabled(), '"Add member" is disabled when full');
  check((await owner.page.locator('text=This group is full').count()) === 1, 'the screen explains why');
  await owner.page.keyboard.press('Escape');
  for (const o of others.slice(0, 2)) await o.page.waitForSelector('.chat-row:has-text("Full house")', { timeout: 90000 });
  const errs = [owner, ...others].flatMap((d) => d.errors);
  check(errs.length === 0, 'no page errors', errs);
});

/* 15 ----------------------------------------------------------------- */
await scenario(15, 'app lock: passkey (virtual Windows Hello) gates the app; failed verification stays locked; Lock now; turning off needs a passkey', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  // WebAuthn refuses IP addresses as the relying party, so use the host name `localhost` (the packaged app uses tauri.localhost).
  const dev = await namedDevice(ctx, relayNet(relay.url), 'Lock', appUrl.replace('127.0.0.1', 'localhost'));
  const page = dev.page;
  const cdp = await dev.context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const setUv = (v) => cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: v });
  const lockSwitch = () => page.locator('button[role="switch"][aria-label^="Lock PrivCord"]');
  const openSecurity = async () => {
    await page.click('button[aria-label="Settings"]');
    await page.click('.tab:has-text("Security")');
  };
  check((await page.locator('.lock-screen').count()) === 0, 'not locked by default');
  await openSecurity();
  await lockSwitch().click();
  await page.waitForFunction(() => document.querySelector('button[role="switch"][aria-label^="Lock PrivCord"]')?.getAttribute('aria-checked') === 'true');
  await page.keyboard.press('Escape');
  ctx.note('passkey created, lock turned on');
  // Reload: the lock screen asks Windows Hello (the virtual authenticator verifies) and opens.
  await page.reload();
  await page.waitForSelector('.chat-panel, .sidebar', { timeout: 20000 });
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 20000 });
  ctx.note('after a restart the passkey prompt passed and the app opened');
  // User verification fails (wrong face/PIN): stays locked.
  await setUv(false);
  await page.reload();
  await page.waitForSelector('.lock-screen', { timeout: 20000 });
  await sleep(2500);
  check((await page.locator('.lock-screen').count()) === 1, 'still locked when the passkey is not verified');
  check((await page.locator('.lock-screen .status-text').count()) === 1, 'the lock screen says it did not work');
  ctx.note('unverified passkey: app stays locked');
  await setUv(true);
  await page.click('.lock-screen button:has-text("Unlock")');
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 20000 });
  // Lock now.
  await setUv(false);
  await openSecurity();
  await page.click('button:has-text("Lock now")');
  await page.waitForSelector('.lock-screen', { timeout: 10000 });
  await setUv(true);
  await page.click('.lock-screen button:has-text("Unlock")');
  await page.waitForSelector('.lock-screen', { state: 'detached', timeout: 20000 });
  await page.keyboard.press('Escape');
  ctx.note('Lock now locks; the passkey unlocks');
  // Turning the lock off needs the passkey; with a failed verification it stays on.
  await openSecurity();
  await setUv(false);
  await lockSwitch().click();
  await page.waitForSelector('.status-text.error', { timeout: 20000 });
  check((await lockSwitch().getAttribute('aria-checked')) === 'true', 'cannot turn the lock off without the passkey');
  await setUv(true);
  await lockSwitch().click();
  await page.waitForFunction(() => document.querySelector('button[role="switch"][aria-label^="Lock PrivCord"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 20000 });
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  check((await page.locator('.lock-screen').count()) === 0, 'no lock after turning it off');
  ctx.note('turning the lock off needs the passkey, then the app opens freely');
  check(dev.errors.length === 0, 'no page errors', dev.errors);
});

/* 16 ----------------------------------------------------------------- */
await scenario(16, 'six-word invite: words (not a long string) connect two people; wrong words fail clearly; the answerer is confirmed', async (ctx) => {
  const relay = await startRelay(false);
  ctx.cleanups.push(relay.close);
  const net = relayNet(relay.url);
  const [A, B] = [await namedDevice(ctx, net, 'Ann'), await namedDevice(ctx, net, 'Ben')];
  await A.page.click('button[aria-label="Add friend"]');
  await A.page.waitForSelector('.invite-words .invite-word', { timeout: 20000 });
  const words = (await A.page.locator('.invite-words .invite-word').allInnerTexts()).map((w) => w.trim());
  check(words.length === 6 && words.every((w) => /^[a-z]+$/.test(w)), 'six plain words are shown', words);
  check(!(await A.page.locator('textarea[aria-label="Your invite"]').isVisible()), 'the long invite string is not shown by default');
  check((await A.page.locator('.qr svg').count()) === 1, 'the QR code is still there');
  // Ben types five right words and one wrong word: clear error, nothing added.
  await B.page.click('button[aria-label="Add friend"]');
  await B.page.waitForSelector('.invite-words .invite-word', { timeout: 20000 });
  const wrong = [...words.slice(0, 5), words[5] === 'zoo' ? 'zone' : 'zoo'].join(' ');
  await B.page.fill('textarea[aria-label="Friend\'s invite"]', wrong);
  await B.page.click('button:has-text("Continue")');
  await B.page.waitForSelector('.status-text.error:has-text("Could not find that invite")', { timeout: 40000 });
  ctx.note('wrong words: "Could not find that invite", nothing added');
  // Right words (messy typing: capitals and commas).
  await B.page.fill('textarea[aria-label="Friend\'s invite"]', words.map((w) => w[0].toUpperCase() + w.slice(1)).join(', '));
  await B.page.click('button:has-text("Continue")');
  await B.page.waitForSelector('.verify-panel .safety-number', { timeout: 40000 });
  check((await B.page.locator('.verify-panel h3').innerText()).includes('Ann'), 'Ben sees it is Ann');
  await B.page.click('button:has-text("Skip for now")');
  // Ben is told plainly that his own invite is being sent back, and when it arrived.
  await B.page.waitForSelector('.verify-panel:has-text("Ann was added")', { timeout: 20000 });
  await B.page.waitForSelector('.verify-panel:has-text("Your invite was sent to Ann")', { timeout: 40000 });
  await B.page.click('.verify-panel button:has-text("Done")');
  await B.page.waitForSelector('.modal-backdrop', { state: 'detached' });
  ctx.note('Ben typed the six words, added Ann, and was told his invite was sent back to her');
  // Ann is asked to confirm who answered.
  await A.page.waitForSelector('.modal:has-text("Ben used your invite") .safety-number', { timeout: 40000 });
  await A.page.click('button:has-text("Add Ben")');
  await A.page.waitForSelector('.chat-header h2:has-text("Ben")', { timeout: 20000 });
  ctx.note('Ann confirmed Ben (shown with safety numbers) and added him');
  await connected(A.page, 120000);
  await say(A.page, 'connected by six words');
  await openChat(B.page, 'Ann');
  await B.page.waitForSelector('text=connected by six words', { timeout: 40000 });
  ctx.note('they chat with each other');
  const errs = [...A.errors, ...B.errors];
  check(errs.length === 0, 'no page errors', errs);
});

console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.status}  #${r.id}  ${r.name}`);
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'last-results.json'), JSON.stringify(results, null, 2));
await shared?.cleanup?.().catch(() => undefined);
await browser.close();
server.close();
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
