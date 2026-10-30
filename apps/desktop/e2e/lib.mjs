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
  await page.click('text=Start DuoChat');
  await page.waitForSelector('.chat-header', { timeout: 15000 });
  return words.join(' ');
}

export async function uidOf(page) {
  await page.click('button[aria-label="Settings"]');
  const uid = await page.locator('.settings-content dd.selectable').first().innerText();
  await page.keyboard.press('Escape');
  return uid.trim();
}

export async function pair(a, b) {
  const cards = [];
  for (const p of [a, b]) {
    await p.click('button[aria-label="Add your friend"]');
    cards.push(await p.locator('textarea[aria-label="Your contact card"]').inputValue());
  }
  const numbers = [];
  for (const [p, card] of [[a, cards[1]], [b, cards[0]]]) {
    await p.fill('textarea[aria-label="Friend\'s contact card"]', card);
    await p.click('button:has-text("Continue")');
    await p.waitForSelector('.verify-panel .safety-number');
    numbers.push(await p.locator('.verify-panel .safety-number').innerText());
  }
  for (const p of [a, b]) await p.click('text=Numbers match, save friend');
  return { cards, numbers };
}

export async function connected(page, ms = 90000) {
  await page.waitForFunction(
    () => document.querySelector('.composer textarea')?.getAttribute('placeholder') === 'Write a message…',
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

/** Label shown in Settings > Connection (the app's own claim). */
export async function uiPath(page) {
  await page.click('button[aria-label="Settings"]');
  await page.click('.settings-nav-button:has-text("Connection")');
  await page.waitForSelector('.callout strong', { timeout: 20000 });
  const label = await page.locator('.callout strong').first().innerText();
  await page.keyboard.press('Escape');
  return label.replace(/\.$/, '');
}

export const relayNet = (url, extra = {}) => ({ stun: [], turn: [], signaling: [{ kind: 'relay', url }], storeForward: false, forceRelay: false, ...extra });
