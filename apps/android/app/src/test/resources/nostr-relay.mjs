// Minimal in-memory NIP-01 relay for the Kotlin interop test: REQ / EVENT / CLOSE, `#t` filter,
// stores only kind 31733 (like a real relay stores non-ephemeral kinds). Usage: node nostr-relay.mjs <port> <path-to-ws>
import { createRequire } from 'node:module';
const [port, wsPath] = [Number(process.argv[2]), process.argv[3]];
const { WebSocketServer } = createRequire(import.meta.url)(wsPath);
const wss = new WebSocketServer({ port, host: '127.0.0.1' });
const stored = [];
const subs = new Map(); // ws -> Map(subId -> filter)
const matches = (f, e) =>
  (!f.kinds || f.kinds.includes(e.kind)) && (!f['#t'] || e.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) && (!f.since || e.created_at >= f.since);
wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m[0] === 'REQ') {
      subs.get(ws).set(m[1], m[2]);
      for (const e of stored) if (matches(m[2], e)) ws.send(JSON.stringify(['EVENT', m[1], e]));
      ws.send(JSON.stringify(['EOSE', m[1]]));
    } else if (m[0] === 'CLOSE') subs.get(ws).delete(m[1]);
    else if (m[0] === 'EVENT') {
      const e = m[1];
      if (e.kind === 31733) stored.push(e);
      for (const [other, s] of subs) for (const [id, f] of s) if (matches(f, e)) other.send(JSON.stringify(['EVENT', id, e]));
      ws.send(JSON.stringify(['OK', e.id, true, '']));
    }
  });
  ws.on('close', () => subs.delete(ws));
});
console.log('ready');
