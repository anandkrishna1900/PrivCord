import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startRelay, MAX_BLOB, MAX_PER_MAILBOX } from '../server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    next(pred = () => true, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for frame')), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    quiet: async (ms = 300) => { await sleep(ms); return inbox.length === 0; },
    close: () => ws.close(),
  };
}

async function withRelay(opts, fn) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'relay-'));
  const relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir, ...opts });
  try { await fn(relay, dataDir); } finally { await relay.close(); if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true }); }
}

test('live sig delivery between two clients, not persisted', async () => {
  await withRelay({ allowStoreForward: true }, async (relay, dir) => {
    const a = await client(relay.port), b = await client(relay.port);
    b.send({ op: 'sub', mailbox: 'mb-b' });
    await b.next((m) => m.op === 'ok');
    a.send({ op: 'put', mailbox: 'mb-b', id: 's1', blob: 'SEALED', ttl: 60, kind: 'sig' });
    const ev = await b.next((m) => m.op === 'event');
    assert.equal(ev.blob, 'SEALED'); assert.equal(ev.id, 's1'); assert.equal(ev.mailbox, 'mb-b');
    assert.equal((await a.next((m) => m.op === 'ok')).id, 's1');
    // a late subscriber gets nothing: sig is live only
    const c = await client(relay.port);
    c.send({ op: 'sub', mailbox: 'mb-b' });
    await c.next((m) => m.op === 'ok');
    assert.ok(await c.quiet());
    assert.ok(!existsSync(join(dir, 'queue.jsonl')) || readFileSync(join(dir, 'queue.jsonl'), 'utf8') === '');
    a.close(); b.close(); c.close();
  });
});

test('msg is persisted and replayed after server restart; del removes it; since is respected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-'));
  try {
    let relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, allowStoreForward: true });
    let a = await client(relay.port);
    a.send({ op: 'put', mailbox: 'mb', id: 'm1', blob: 'ONE', ttl: 3600, kind: 'msg' });
    await a.next((m) => m.op === 'ok');
    await sleep(20);
    const mid = Date.now();
    await sleep(20);
    a.send({ op: 'put', mailbox: 'mb', id: 'm2', blob: 'TWO', ttl: 3600, kind: 'msg' });
    await a.next((m) => m.op === 'ok');
    a.send({ op: 'put', mailbox: 'mb', id: 'm3', blob: 'THREE', ttl: 3600, kind: 'msg' });
    await a.next((m) => m.op === 'ok');
    a.send({ op: 'del', mailbox: 'mb', id: 'm3' });
    await a.next((m) => m.op === 'ok');
    a.close();
    await relay.close();

    relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, allowStoreForward: true });
    const b = await client(relay.port);
    b.send({ op: 'sub', mailbox: 'mb' });
    const got = [await b.next((m) => m.op === 'event'), await b.next((m) => m.op === 'event')].map((m) => m.blob).sort();
    assert.deepEqual(got, ['ONE', 'TWO']);
    await b.next((m) => m.op === 'ok');
    assert.ok(await b.quiet(), 'deleted m3 must not replay');

    const c = await client(relay.port);
    c.send({ op: 'sub', mailbox: 'mb', since: mid });
    assert.equal((await c.next((m) => m.op === 'event')).blob, 'TWO');
    await c.next((m) => m.op === 'ok');
    assert.ok(await c.quiet());
    b.close(); c.close();
    await relay.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('msg ttl expiry: not replayed after expiry, and dropped across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-'));
  try {
    let relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, allowStoreForward: true, sweepMs: 100 });
    const a = await client(relay.port);
    a.send({ op: 'put', mailbox: 'mb', id: 'e1', blob: 'SHORT', ttl: 1, kind: 'msg' });
    await a.next((m) => m.op === 'ok');
    await sleep(1300);
    const b = await client(relay.port);
    b.send({ op: 'sub', mailbox: 'mb' });
    await b.next((m) => m.op === 'ok');
    assert.ok(await b.quiet(), 'expired item must not replay');
    // restart path: put, close, wait past ttl, reopen
    a.send({ op: 'put', mailbox: 'mb', id: 'e2', blob: 'SHORT2', ttl: 1, kind: 'msg' });
    await a.next((m) => m.op === 'ok');
    a.close(); b.close();
    await relay.close();
    await sleep(1200);
    relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: dir, allowStoreForward: true });
    const c = await client(relay.port);
    c.send({ op: 'sub', mailbox: 'mb' });
    await c.next((m) => m.op === 'ok');
    assert.ok(await c.quiet());
    assert.equal(readFileSync(join(dir, 'queue.jsonl'), 'utf8'), '');
    c.close();
    await relay.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('limits: blob size, ttl caps, bad frames, mailbox capacity', async () => {
  await withRelay({ allowStoreForward: true, rateLimit: 10_000 }, async (relay) => {
    const a = await client(relay.port);
    const put = async (o) => { a.send({ op: 'put', mailbox: 'mb', kind: 'sig', ttl: 10, ...o }); return a.next((m) => m.op === 'ok' || m.op === 'err'); };
    assert.equal((await put({ id: 'big', blob: 'x'.repeat(MAX_BLOB + 1) })).reason, 'blob too large');
    assert.equal((await put({ id: 'edge', blob: 'x'.repeat(MAX_BLOB) })).op, 'ok');
    assert.equal((await put({ id: 'sig-ttl', blob: 'x', ttl: 121 })).reason, 'ttl too large');
    assert.equal((await put({ id: 'msg-ttl', blob: 'x', kind: 'msg', ttl: 7 * 24 * 3600 + 1 })).reason, 'ttl too large');
    assert.equal((await put({ id: 'kind', blob: 'x', kind: 'other' })).reason, 'bad kind');
    assert.equal((await put({ id: 'ttl0', blob: 'x', ttl: 0 })).reason, 'bad ttl');
    a.ws.send('not json');
    assert.equal((await a.next((m) => m.op === 'err')).reason, 'bad json');
    a.send({ op: 'nope' });
    assert.equal((await a.next((m) => m.op === 'err')).reason, 'unknown op');
    for (let i = 0; i < MAX_PER_MAILBOX; i++) {
      assert.equal((await put({ id: `q${i}`, blob: 'x', kind: 'msg', ttl: 60, mailbox: 'full' })).op, 'ok');
    }
    const over = await put({ id: 'q-over', blob: 'x', kind: 'msg', ttl: 60, mailbox: 'full' });
    assert.equal(over.reason, 'mailbox full');
    a.close();
  });
});

test('per-IP rate limit', async () => {
  await withRelay({ rateLimit: 5, rateWindowMs: 60_000 }, async (relay) => {
    const a = await client(relay.port);
    for (let i = 0; i < 5; i++) {
      a.send({ op: 'put', mailbox: 'mb', id: `r${i}`, blob: 'x', ttl: 10, kind: 'sig' });
      assert.equal((await a.next()).op, 'ok');
    }
    a.send({ op: 'put', mailbox: 'mb', id: 'r6', blob: 'x', ttl: 10, kind: 'sig' });
    assert.equal((await a.next()).reason, 'rate limited');
    const b = await client(relay.port); // same IP: still limited
    b.send({ op: 'sub', mailbox: 'mb' });
    assert.equal((await b.next()).reason, 'rate limited');
    a.close(); b.close();
  });
});

test('store-and-forward disabled rejects msg but still relays sig', async () => {
  await withRelay({ allowStoreForward: false }, async (relay) => {
    const a = await client(relay.port), b = await client(relay.port);
    b.send({ op: 'sub', mailbox: 'mb' });
    await b.next((m) => m.op === 'ok');
    a.send({ op: 'put', mailbox: 'mb', id: 'm', blob: 'x', ttl: 60, kind: 'msg' });
    assert.equal((await a.next()).reason, 'store-and-forward disabled');
    assert.ok(await b.quiet());
    a.send({ op: 'put', mailbox: 'mb', id: 's', blob: 'x', ttl: 60, kind: 'sig' });
    assert.equal((await b.next((m) => m.op === 'event')).id, 's');
    a.close(); b.close();
  });
});

test('/healthz reports counters only', async () => {
  await withRelay({}, async (relay) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(Object.keys(body).sort(), ['connections', 'delivered', 'mailboxes', 'ok', 'put', 'queued', 'rejected']);
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/other`)).status, 404);
  });
});
