// DuoChat relay: a mailbox for sealed blobs. It never parses, logs or
// decrypts blob contents; it sees mailbox hashes, sizes and timing only.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

export const MAX_BLOB = 64 * 1024;
export const MAX_SIG_TTL = 120;
export const MAX_MSG_TTL = 7 * 24 * 3600;
export const MAX_PER_MAILBOX = 500;
const MAX_SUBS_PER_CONN = 16;
const MAX_FIELD = 128;

export function startRelay({
  port = 8787,
  host = '0.0.0.0',
  dataDir = './data',
  allowStoreForward = false,
  rateLimit = 120, // frames per window per IP
  rateWindowMs = 60_000,
  sweepMs = 500,
} = {}) {
  /** @type {Map<string, Map<string, {id:string, blob:string, ts:number, exp:number}>>} persisted msg items */
  const queues = new Map();
  /** @type {Map<string, Set<import('ws').WebSocket>>} */
  const subs = new Map();
  const rates = new Map(); // ip -> {n, reset}
  const stats = { connections: 0, put: 0, delivered: 0, rejected: 0 };
  const logFile = join(dataDir, 'queue.jsonl');

  if (allowStoreForward) {
    mkdirSync(dataDir, { recursive: true });
    load();
  }

  function queued() {
    let n = 0;
    for (const q of queues.values()) n += q.size;
    return n;
  }

  function load() {
    if (!existsSync(logFile)) return;
    const now = Date.now();
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.op === 'put') {
        if (r.exp <= now) continue;
        let q = queues.get(r.mailbox);
        if (!q) queues.set(r.mailbox, (q = new Map()));
        q.set(r.id, { id: r.id, blob: r.blob, ts: r.ts, exp: r.exp });
      } else if (r.op === 'del') {
        queues.get(r.mailbox)?.delete(r.id);
      }
    }
    compact();
  }

  // Rewrite the log from live state: drops deleted/expired lines.
  function compact() {
    if (!allowStoreForward) return;
    const lines = [];
    for (const [mailbox, q] of queues) {
      for (const it of q.values()) lines.push(JSON.stringify({ op: 'put', mailbox, ...it }));
    }
    const tmp = logFile + '.tmp';
    writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
    renameSync(tmp, logFile);
  }

  function persist(rec) {
    appendFileSync(logFile, JSON.stringify(rec) + '\n');
  }

  function sweep() {
    const now = Date.now();
    for (const [mailbox, q] of queues) {
      for (const [id, it] of q) if (it.exp <= now) q.delete(id);
      if (q.size === 0) queues.delete(mailbox);
    }
    for (const [ip, r] of rates) if (r.reset <= now) rates.delete(ip);
  }
  const sweeper = setInterval(sweep, sweepMs);
  sweeper.unref();

  const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;

  function limited(ip) {
    const now = Date.now();
    let r = rates.get(ip);
    if (!r || r.reset <= now) rates.set(ip, (r = { n: 0, reset: now + rateWindowMs }));
    return ++r.n > rateLimit;
  }

  function handle(ws, ip, raw) {
    if (limited(ip)) {
      stats.rejected++;
      return send(ws, { op: 'err', reason: 'rate limited' });
    }
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return send(ws, { op: 'err', reason: 'bad json' }); }
    if (!m || typeof m !== 'object') return send(ws, { op: 'err', reason: 'bad frame' });
    const fail = (reason) => { stats.rejected++; send(ws, { op: 'err', reason, ...(typeof m.id === 'string' && m.id.length <= MAX_FIELD ? { id: m.id } : {}) }); };

    switch (m.op) {
      case 'sub': {
        if (!str(m.mailbox)) return fail('bad mailbox');
        if (ws.mailboxes.size >= MAX_SUBS_PER_CONN && !ws.mailboxes.has(m.mailbox)) return fail('too many subscriptions');
        ws.mailboxes.add(m.mailbox);
        let set = subs.get(m.mailbox);
        if (!set) subs.set(m.mailbox, (set = new Set()));
        set.add(ws);
        const since = Number.isFinite(m.since) ? m.since : 0;
        const now = Date.now();
        for (const it of queues.get(m.mailbox)?.values() ?? []) {
          if (it.exp > now && it.ts > since) {
            send(ws, { op: 'event', mailbox: m.mailbox, id: it.id, blob: it.blob, ts: it.ts });
            stats.delivered++;
          }
        }
        return send(ws, { op: 'ok' });
      }
      case 'put': {
        if (!str(m.mailbox)) return fail('bad mailbox');
        if (!str(m.id)) return fail('bad id');
        if (typeof m.blob !== 'string' || m.blob.length === 0) return fail('bad blob');
        if (m.blob.length > MAX_BLOB) return fail('blob too large');
        if (m.kind !== 'sig' && m.kind !== 'msg') return fail('bad kind');
        if (!Number.isInteger(m.ttl) || m.ttl <= 0) return fail('bad ttl');
        if (m.ttl > (m.kind === 'sig' ? MAX_SIG_TTL : MAX_MSG_TTL)) return fail('ttl too large');
        const ts = Date.now();
        if (m.kind === 'msg') {
          if (!allowStoreForward) return fail('store-and-forward disabled');
          let q = queues.get(m.mailbox);
          if (!q) queues.set(m.mailbox, (q = new Map()));
          if (!q.has(m.id)) {
            if (q.size >= MAX_PER_MAILBOX) return fail('mailbox full');
            const it = { id: m.id, blob: m.blob, ts, exp: ts + m.ttl * 1000 };
            q.set(m.id, it);
            persist({ op: 'put', mailbox: m.mailbox, ...it });
          }
        }
        // sig: live delivery only, never stored.
        stats.put++;
        for (const sub of subs.get(m.mailbox) ?? []) {
          send(sub, { op: 'event', mailbox: m.mailbox, id: m.id, blob: m.blob, ts });
          stats.delivered++;
        }
        return send(ws, { op: 'ok', id: m.id });
      }
      case 'del': {
        if (!str(m.mailbox) || !str(m.id)) return fail('bad del');
        const q = queues.get(m.mailbox);
        if (q?.delete(m.id)) {
          if (q.size === 0) queues.delete(m.mailbox);
          persist({ op: 'del', mailbox: m.mailbox, id: m.id });
        }
        return send(ws, { op: 'ok', id: m.id });
      }
      default:
        return fail('unknown op');
    }
  }

  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, queued: queued(), mailboxes: subs.size, ...stats }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_BLOB + 1024 });
  wss.on('connection', (ws, req) => {
    // IP is used in memory for rate limiting only; never logged or stored.
    const ip = req.socket.remoteAddress ?? 'unknown';
    ws.mailboxes = new Set();
    stats.connections++;
    ws.on('message', (raw) => handle(ws, ip, raw));
    ws.on('close', () => {
      for (const mb of ws.mailboxes) {
        const set = subs.get(mb);
        set?.delete(ws);
        if (set?.size === 0) subs.delete(mb);
      }
    });
    ws.on('error', () => {});
  });

  return new Promise((resolve) => {
    http.listen(port, host, () => {
      resolve({
        port: http.address().port,
        async close() {
          clearInterval(sweeper);
          for (const ws of wss.clients) ws.close(1001);
          await new Promise((r) => wss.close(r));
          await new Promise((r) => { http.close(r); http.closeAllConnections?.(); });
          compact();
        },
      });
    });
  });
}
