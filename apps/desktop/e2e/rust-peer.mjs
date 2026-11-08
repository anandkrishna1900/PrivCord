// Live interop: the real desktop app (built, running in headless Chromium) talks over a simulated Bluetooth radio to the
// Rust engine running as a separate process (crates/privcord-engine/examples/peer.rs). Nothing on either side is mocked
// except the radio itself. Usage: node e2e/rust-peer.mjs   (cargo build -p privcord-engine --example peer first)
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { addFriend, build, connected, device, launch, onboard, openAdd, repo, say, serve, uidOf, uiPath } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg, evidence) => {
  if (!ok) throw new Error(`${msg}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ''}`);
  console.log(`ok   ${msg}`);
};

/** The Rust engine as a child process, driven by JSON lines. */
function startPeer() {
  const bin = path.join(repo, 'target/debug/examples/peer');
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let next = 1;
  const pending = new Map();
  const peer = { chunks: [], onChunk: null, child };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.ev === 'chunk') {
      peer.chunks.push(m.data);
      peer.onChunk?.(m.data);
    } else if (pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if ('err' in m) reject(new Error(m.err));
      else resolve(m.ok);
    }
  });
  peer.call = (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  return peer;
}

const dist = build();
const { server, url: appUrl } = await serve(dist);
const browser = await launch();
const peer = startPeer();
let failed = false;
try {
  const offline = { stun: [], turn: [], signaling: [], storeForward: false, forceRelay: false, bluetooth: true };
  const dev = await device(browser, appUrl, offline);
  const air = []; // everything an eavesdropper would see, both directions
  let tsUid = null;
  const emit = (event) => dev.page.evaluate((e) => window.__duochatBleHandler?.(e), event).catch(() => undefined);

  // Chunks the Rust side sends before the page has been told the link is open are held, like a real radio would.
  let held = [];
  let isOpen = false;
  await dev.context.exposeBinding('__bleConnect', async () => {
    isOpen = false;
    await peer.call('link_up', { peer: tsUid });
    await emit({ kind: 'open', maxChunk: 185 });
    isOpen = true;
    for (const hex of held.splice(0)) await emit({ kind: 'chunk', data: hex });
    return 185;
  });
  await dev.context.exposeBinding('__bleWrite', async (_src, hex) => {
    air.push(hex);
    await peer.call('chunk', { peer: tsUid, data: hex });
  });
  await dev.context.exposeBinding('__bleDisc', async () => {
    await peer.call('link_down', { peer: tsUid }).catch(() => undefined);
  });
  peer.onChunk = (hex) => {
    air.push(hex);
    if (isOpen) void emit({ kind: 'chunk', data: hex });
    else held.push(hex);
  };
  await dev.context.addInitScript(() => {
    window.__duochatBleBridge = {
      capabilities: async () => ({ central: true, peripheral: false, platform: 'simulated' }),
      connect: (tags, timeoutSecs) => window.__bleConnect(tags, timeoutSecs),
      write: (hex) => window.__bleWrite(hex),
      disconnect: () => window.__bleDisc(),
      onEvent: async (handler) => {
        window.__duochatBleHandler = handler;
        return () => {
          window.__duochatBleHandler = null;
        };
      },
    };
  });
  await dev.page.reload();
  await onboard(dev.page);

  // Pair: the app's invite goes to Rust, Rust's card goes into the app's Add-friend dialog.
  const { card: rustCard } = await peer.call('init', { name: 'Rusty' });
  const appInvite = await openAdd(dev.page);
  await dev.page.keyboard.press('Escape');
  tsUid = (await peer.call('add', { card: appInvite })).uid;
  check(tsUid === (await uidOf(dev.page)), 'Rust parsed the desktop app\'s invite and derived the same uid the app shows');
  await addFriend(dev.page, rustCard);

  await connected(dev.page, 30000).catch(async (e) => { console.log(JSON.stringify(await peer.call('snapshot'))); console.log(await dev.page.locator('.chat-header-identity').allInnerTexts().catch(()=>''), await dev.page.locator('.notice, .toast, [role=status], [role=alert]').allInnerTexts().catch(()=>'')); throw e; });
  const label = await uiPath(dev.page);
  check(label === 'Bluetooth, no internet', 'the app reports a Bluetooth link', label);
  for (let i = 0; i < 100; i += 1) {
    const s = await peer.call('snapshot');
    if (s.contacts.some((c) => c.connected)) break;
    await sleep(100);
  }
  check((await peer.call('snapshot')).contacts.some((c) => c.connected), 'the Rust engine considers the link connected too');

  // App -> Rust.
  const toRust = 'app-to-rust-marker-4417';
  await say(dev.page, toRust);
  let got = false;
  for (let i = 0; i < 100 && !got; i += 1) {
    got = (await peer.call('snapshot')).messages.some((m) => m.text === toRust);
    if (!got) await sleep(100);
  }
  check(got, 'a message typed in the real desktop app reached the Rust engine');

  // Rust -> app.
  const toApp = 'rust-to-app-marker-9026';
  const ownUid = (await peer.call('snapshot')).own;
  await peer.call('send', { peer: tsUid, text: toApp });
  await dev.page.waitForSelector(`text=${toApp}`, { timeout: 15000 });
  check(true, 'a message sent by the Rust engine appeared in the real desktop app');
  check(ownUid !== tsUid, 'the two sides are different identities');

  // Delivery receipt back to Rust (the app acks what it received).
  let delivered = false;
  for (let i = 0; i < 100 && !delivered; i += 1) {
    const mine = (await peer.call('snapshot')).messages.find((m) => m.text === toApp);
    delivered = /Delivered|Read/.test(mine?.delivery ?? '');
    if (!delivered) await sleep(100);
  }
  check(delivered, 'the app acknowledged the Rust message (delivery state advanced on the Rust side)');

  // What the radio carried.
  const wire = Buffer.from(air.join('').match(/../g).map((h) => parseInt(h, 16))).toString('latin1');
  check(air.length > 4, 'chunks crossed the radio both ways', air.length);
  check(!wire.includes(toRust) && !wire.includes(toApp), 'neither message text appears on the air');
  check(!wire.includes('publicKeyJwk'), 'the identity handshake is not readable on the air');
  check(dev.errors.length === 0, 'no page errors', dev.errors);
} catch (error) {
  failed = true;
  console.log(`FAIL ${error.message}`);
} finally {
  peer.child.kill();
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
