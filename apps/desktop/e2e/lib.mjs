// Shared helpers for the desktop E2E suite. Plain node + the preinstalled playwright.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const desktop = path.resolve(here, '..');
export const repo = path.resolve(desktop, '../..');

const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
export const { chromium } = createRequire(path.join(globalRoot, 'x.js'))('playwright');

/* ---------- build + static server ---------- */
export function build() {
  const out = path.join(os.tmpdir(), 'duochat-e2e-dist');
  execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: desktop, stdio: 'ignore' });
  return out;
}

export function serve(dir) {
  return new Promise((resolve) => {
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    const server = http.createServer((req, res) => {
      let p = path.join(dir, req.url.split('?')[0]);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dir, 'index.html');
      res.setHeader('content-type', types[path.extname(p)] ?? 'application/octet-stream');
      res.end(fs.readFileSync(p));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ---------- backends ---------- */
export async function startRelay(allowStoreForward = false) {
  const { startRelay: start } = await import(path.join(repo, 'relay/server.js'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duochat-relay-'));
  const relay = await start({ port: 0, dataDir, allowStoreForward });
  return { url: `ws://127.0.0.1:${relay.port}`, dataDir, close: () => relay.close() };
}

/** Tiny in-memory NIP-01 relay: REQ / EVENT / CLOSE, ephemeral (20000-29999) not stored, `#t` + kinds + since filters. */
export async function startNostrRelay() {
  const { WebSocketServer } = createRequire(path.join(repo, 'relay/x.js'))('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const stored = [];
  const seen = []; // every event kind that crossed the relay
  const subs = new Map(); // ws -> Map(subId -> filter)
  const matches = (f, e) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.since || e.created_at >= f.since) &&
    (!f['#t'] || e.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1])));
  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m[0] === 'REQ') {
        subs.get(ws).set(m[1], m[2]);
        for (const e of stored) if (matches(m[2], e)) ws.send(JSON.stringify(['EVENT', m[1], e]));
        ws.send(JSON.stringify(['EOSE', m[1]]));
      } else if (m[0] === 'CLOSE') subs.get(ws)?.delete(m[1]);
      else if (m[0] === 'EVENT') {
        const e = m[1];
        seen.push(e.kind);
        if (e.kind < 20000 || e.kind >= 30000) stored.push(e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const [client, map] of subs) for (const [id, f] of map) if (matches(f, e)) client.send(JSON.stringify(['EVENT', id, e]));
      }
    });
  });
  const { port } = wss.address();
  return { url: `ws://127.0.0.1:${port}`, seen, stored, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

/** node-turn installed outside the repo (so the repo gets no new dependency). */
export async function startTurn() {
  const dir = path.join(os.tmpdir(), 'duochat-e2e-turn');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'node_modules/node-turn'))) {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","private":true}');
    execFileSync('npm', ['i', 'node-turn', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' });
  }
  const port = 34780 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(
    path.join(dir, 'run.cjs'),
    `const T=require('node-turn');new T({authMech:'long-term',credentials:{alice:'pw'},listeningPort:${port},listeningIps:['127.0.0.1'],relayIps:['127.0.0.1'],minPort:50000,maxPort:50100,debugLevel:'OFF'}).start();console.log('up');setInterval(()=>{},1e6)`,
  );
  const child = spawn('node', ['run.cjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  await new Promise((r) => setTimeout(r, 300));
  return { url: `turn:127.0.0.1:${port}`, username: 'alice', credential: 'pw', close: () => child.kill() };
}

/* ---------- browser ---------- */
export const launch = () =>
  chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });

/** New isolated "device". `network` is injected as DuoChat's network settings before the app loads. */
export async function device(browser, appUrl, network) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(
    ([cfg]) => {
      if (cfg && !localStorage.getItem('duochat.network.v1')) localStorage.setItem('duochat.network.v1', JSON.stringify(cfg));
      // Record every RTCPeerConnection so the test can ask getStats() what the browser really selected.
      const Orig = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = function (...a) {
        const pc = new Orig(...a);
        window.__pcs.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = Orig.prototype;
    },
    [network],
  );
  const dev = { context, appUrl, page: null, errors: [] };
  dev.open = async () => {
    dev.page = await context.newPage();
    dev.page.on('pageerror', (e) => dev.errors.push(e.message));
    await dev.page.goto(appUrl);
    return dev.page;
  };
  await dev.open();
  return dev;
}

/* ---------- UI flows ---------- */
export async function onboard(page) {
  await page.waitForSelector('.phrase-word-box', { timeout: 15000 });
  const words = await page.locator('.phrase-word-box .word-text').allInnerTexts();
  await page.click('text=I have saved my phrase');
  for (const n of [1, 2]) {
    const label = await page.locator(`label[for=verify-word-${n}]`).innerText();
    await page.fill(`#verify-word-${n}`, words[Number(/#(\d+)/.exec(label)[1]) - 1]);
  }
  await page.click('text=Verify & Confirm');
  await page.click('text=Start PrivCord');
  await page.waitForSelector('.app-shell', { timeout: 15000 });
  return words.join(' ');
}

export async function uidOf(page) {
  await page.click('button[aria-label="Settings"]');
  await page.click('.tab:has-text("About")');
  const uid = await page.locator('.settings-content dd.selectable').first().innerText();
  await page.keyboard.press('Escape');
  return uid.trim();
}

/** Open the Add-friend dialog and return my invite text (dialog stays open). */
export async function openAdd(page) {
  await page.click('button[aria-label="Add friend"]');
  return page.locator('textarea[aria-label="Your invite"]').inputValue();
}

/** Paste an invite; returns the safety number shown (the dialog stays on the check step). */
export async function pasteInvite(page, invite) {
  await page.fill('textarea[aria-label="Friend\'s invite"]', invite);
  await page.click('button:has-text("Continue")');
  await page.waitForSelector('.verify-panel .safety-number');
  return page.locator('.verify-panel .safety-number').innerText();
}

/** Add `invite` as a friend on `page` (verifying the numbers). Returns the safety number. */
export async function addFriend(page, invite, { verify = true } = {}) {
  await page.click('button[aria-label="Add friend"]');
  const number = await pasteInvite(page, invite);
  await page.click(verify ? 'button:has-text("Numbers match")' : 'button:has-text("Skip for now")');
  await page.waitForSelector('.modal-backdrop', { state: 'detached' });
  return number;
}

export async function invites(a, b) {
  const out = [];
  for (const p of [a, b]) {
    out.push(await openAdd(p));
    await p.keyboard.press('Escape');
  }
  return out;
}

export async function pair(a, b) {
  const cards = await invites(a, b);
  const numbers = [];
  numbers.push(await addFriend(a, cards[1]));
  numbers.push(await addFriend(b, cards[0]));
  return { cards, numbers };
}

/** Give this device a name friends see (Settings > Profile). */
export async function setName(page, name) {
  await page.click('button[aria-label="Settings"]');
  await page.fill('.settings-content input', name);
  await page.click('.settings-content button:has-text("Save")');
  await page.waitForSelector('.settings-content .status-text');
  await page.keyboard.press('Escape');
}

export async function newGroup(page, name, friendNames) {
  await page.click('button[aria-label="New group"]');
  await page.getByLabel('Group name').fill(name);
  for (const f of friendNames) await page.locator('.pick-row', { hasText: f }).locator('input').check();
  await page.click('button:has-text("Create group")');
  await page.waitForSelector(`.chat-header h2:has-text("${name}")`);
}

export async function openGroupDetails(page) {
  await page.click('button[aria-label="More"]');
  await page.click('[role="menuitem"]:has-text("Group details")');
  await page.waitForSelector('.member-list');
}

export async function groupAdd(page, friendName) {
  await openGroupDetails(page);
  await page.click('button:has-text("Add member")');
  await page.locator('.pick-row', { hasText: friendName }).locator('input').check();
  await page.click('button:has-text("Add 1")');
  await page.waitForSelector('button:has-text("Add member")');
  await page.keyboard.press('Escape');
}

export async function groupRemove(page, memberName) {
  await openGroupDetails(page);
  await page.locator('.member-row', { hasText: memberName }).locator('button:has-text("Remove")').click();
  await page.waitForFunction((n) => ![...document.querySelectorAll('.member-row')].some((r) => r.textContent.includes(n)), memberName);
  await page.keyboard.press('Escape');
}

export async function memberNames(page) {
  await openGroupDetails(page);
  const names = await page.locator('.member-row strong').allInnerTexts();
  await page.keyboard.press('Escape');
  return names.map((n) => n.replace(/ · admin$/, ''));
}

/** Select a chat in the list by (part of) its name; index fallback. */
export async function openChat(page, nameOrIndex = 0) {
  const rows = page.locator('.chat-row');
  await rows.first().waitFor({ timeout: 15000 });
  if (typeof nameOrIndex === 'number') await rows.nth(nameOrIndex).click();
  else await rows.filter({ hasText: nameOrIndex }).first().click();
  await page.waitForSelector('.chat-header');
}

const statusText = (page) => page.locator('.chat-header-identity p').first().innerText();
export async function isConnected(page) {
  return (await statusText(page).catch(() => '')).startsWith('Connected');
}

export async function connected(page, ms = 90000) {
  await page.waitForFunction(
    () => (document.querySelector('.chat-header-identity p')?.textContent ?? '').startsWith('Connected'),
    null,
    { timeout: ms },
  );
}

export async function say(page, text) {
  await page.fill('.composer textarea', text);
  await page.keyboard.press('Enter');
}

/** What the browser itself says it selected, independent of the app UI. */
export async function realPath(page) {
  return page.evaluate(async () => {
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach((r) => byId.set(r.id, r));
      for (const r of byId.values()) {
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          const pair = byId.get(r.selectedCandidatePairId);
          return { local: byId.get(pair.localCandidateId)?.candidateType, remote: byId.get(pair.remoteCandidateId)?.candidateType };
        }
      }
    }
    return null;
  });
}

/** The path label the app shows in the open chat header ("Connected · Direct, same network"). */
export async function uiPath(page) {
  await connected(page, 20000);
  return (await statusText(page)).replace(/^Connected · /, '').replace(/\.$/, '');
}

export const relayNet = (url, extra = {}) => ({ stun: [], turn: [], signaling: [{ kind: 'relay', url }], storeForward: false, forceRelay: false, ...extra });

/**
 * A simulated Bluetooth radio between two devices: the app's real Bluetooth code (framing, secure
 * channel, handshake) runs unchanged on top; only the radio is replaced. Every chunk that crosses
 * is recorded in `log` so tests can inspect exactly what a Bluetooth eavesdropper would see.
 * `tamper` may rewrite a chunk (return the new hex) to simulate an attacker on the air.
 */
export async function installBleSim(devs) {
  const sim = { log: [], tamper: null, links: 0, events: [] };
  const waiting = [];
  const peers = new Map(); // page -> other page
  const opens = new Map(); // page -> promise resolved once both ends were told the link is open
  const emit = (page, event) => page.evaluate((e) => window.__duochatBleHandler?.(e), event).catch(() => undefined);
  for (const dev of devs) {
    await dev.context.exposeBinding('__bleConnect', async ({ page }, _tags, timeoutSecs) => {
      sim.events.push(`${dev.name} connect`);
      const other = waiting.find((w) => w.page !== page);
      if (other) {
        waiting.splice(waiting.indexOf(other), 1);
        clearTimeout(other.timer);
        peers.set(page, other.page);
        peers.set(other.page, page);
        sim.links += 1;
        // A real radio never delivers data before both ends know the link is open; writes wait for this.
        const opened = Promise.all([emit(page, { kind: 'open', maxChunk: 185 }), emit(other.page, { kind: 'open', maxChunk: 185 })]);
        opens.set(page, opened);
        opens.set(other.page, opened);
        await opened;
        other.resolve(185);
        return 185;
      }
      return new Promise((resolve, reject) => {
        const entry = { page, resolve };
        entry.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new Error('No paired device found nearby.'));
        }, Math.min(timeoutSecs, 20) * 1000);
        waiting.push(entry);
      });
    });
    await dev.context.exposeBinding('__bleWrite', async ({ page }, hex) => {
      const other = peers.get(page);
      if (!other) return;
      await opens.get(page);
      const data = sim.tamper ? sim.tamper(hex) : hex;
      sim.log.push({ from: devs.find((d) => d.page === page || d.context === page.context())?.name ?? '?', hex: data });
      await emit(other, { kind: 'chunk', data });
    });
    await dev.context.exposeBinding('__bleDisc', async ({ page }) => {
      sim.events.push(`${dev.name} disconnect`);
      const other = peers.get(page);
      peers.delete(page);
      if (other) {
        peers.delete(other);
        await emit(other, { kind: 'close' });
      }
    });
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
  }
  sim.text = () =>
    sim.log.map((c) => Buffer.from(c.hex.match(/../g).map((h) => parseInt(h, 16))).toString('latin1')).join('');
  return sim;
}

/** Settings > Security: the "stay group-only" privacy switch. */
export async function setGroupOnly(page, on) {
  await page.click('button[aria-label="Settings"]');
  await page.click('.tab:has-text("Security")');
  const sw = page.locator('button[role="switch"][aria-label^="Stay group-only"]');
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  await page.waitForFunction((v) => document.querySelector('button[role="switch"][aria-label^="Stay group-only"]')?.getAttribute('aria-checked') === String(v), on);
  await page.keyboard.press('Escape');
}

/** From group details: open the direct chat with a member (only possible once verified). */
export async function messageMember(page, name) {
  await openGroupDetails(page);
  await page.locator('.member-row', { hasText: name }).locator('button:has-text("Message")').click();
  await page.waitForSelector(`.chat-header h2:has-text("${name}")`);
}

export async function sendFile(page, { name, mime, buffer }) {
  await page.setInputFiles('input[type=file]', { name, mimeType: mime, buffer });
}

/** Click Save on the file bubble that mentions `name` and return the downloaded bytes. */
export async function saveFile(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('.file-bubble', { hasText: name }).first().locator('button[aria-label^="Save"]').click(),
  ]);
  const p = await download.path();
  return { bytes: (await import('node:fs')).readFileSync(p), suggested: download.suggestedFilename() };
}
