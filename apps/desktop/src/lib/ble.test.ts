import { describe, expect, it } from 'vitest';
import { BleTransport, type BleBridge, type BleBridgeEvent } from './ble';
import { bleAcceptTags, chunkMessage } from './bleFraming';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

function fakeBridge(opts: { central?: boolean; maxChunk?: number; failWrite?: boolean } = {}) {
  let handler: (e: BleBridgeEvent) => void = () => undefined;
  const log = { tags: [] as string[], writes: [] as string[], disconnects: 0 };
  const bridge: BleBridge = {
    capabilities: async () => ({ central: opts.central ?? true, peripheral: false, platform: 'test' }),
    connect: async (tags) => {
      log.tags = tags;
      return opts.maxChunk ?? 8;
    },
    write: async (c) => {
      if (opts.failWrite) throw new Error('boom');
      log.writes.push(c);
    },
    disconnect: async () => {
      log.disconnects += 1;
    },
    onEvent: async (h) => {
      handler = h;
      return () => {
        handler = () => undefined;
      };
    },
  };
  return { bridge, log, emit: (e: BleBridgeEvent) => handler(e) };
}

function setup(opts?: Parameters<typeof fakeBridge>[0]) {
  const f = fakeBridge(opts);
  const seen = { open: 0, close: 0, frames: [] as string[], errors: [] as string[] };
  const t = new BleTransport(f.bridge, {
    onOpen: () => (seen.open += 1),
    onClose: () => (seen.close += 1),
    onFrame: (d) => seen.frames.push(d),
    onError: (m) => seen.errors.push(m),
  });
  return { ...f, t, seen };
}

const secret = new Uint8Array(32).fill(7);

describe('BleTransport (fake bridge; no hardware)', () => {
  it('asks the native side for previous/current/next epoch tags', async () => {
    const { t, log } = setup();
    await t.connect(secret, 30, 900_000);
    expect(log.tags).toEqual((await bleAcceptTags(secret, 900_000)).map(hex));
    expect(log.tags).toHaveLength(3);
  });

  it('refuses when the platform has no central role', async () => {
    const { t } = setup({ central: false });
    await expect(t.connect(secret)).rejects.toThrow(/not available/);
  });

  it('opens on the native open event and reassembles incoming chunks into a frame', async () => {
    const { t, emit, seen } = setup();
    await t.connect(secret);
    expect(t.isOpen).toBe(false);
    emit({ kind: 'open', maxChunk: 8 });
    expect(t.isOpen).toBe(true);
    expect(seen.open).toBe(1);
    const json = '{"v":1,"kind":"hello"}';
    for (const c of chunkMessage(new TextEncoder().encode(json), 8)) emit({ kind: 'chunk', data: hex(c) });
    expect(seen.frames).toEqual([json]);
  });

  it('chunks outgoing frames to the negotiated size, in order', async () => {
    const { t, emit, log } = setup();
    await t.connect(secret);
    emit({ kind: 'open', maxChunk: 10 });
    expect(t.sendJson({ v: 1, kind: 'read', at: 1 })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.writes.length).toBeGreaterThan(1);
    expect(log.writes.every((c) => c.length / 2 <= 10)).toBe(true);
    const bytes = log.writes.map(unhex);
    expect(bytes[0]![0]! & 1).toBe(1); // START
    expect(bytes.at(-1)![0]! & 2).toBe(2); // END
  });

  it('rejects sends while not open', async () => {
    const { t } = setup();
    await t.connect(secret);
    expect(t.sendJson({ a: 1 })).toBe(false);
  });

  it('reports malformed chunks without closing the link', async () => {
    const { t, emit, seen } = setup();
    await t.connect(secret);
    emit({ kind: 'open', maxChunk: 8 });
    emit({ kind: 'chunk', data: '00000061' }); // continuation without START
    expect(seen.errors[0]).toMatch(/framing/i);
    expect(t.isOpen).toBe(true);
  });

  it('closes once on native close and on local close', async () => {
    const a = setup();
    await a.t.connect(secret);
    a.emit({ kind: 'open', maxChunk: 8 });
    a.emit({ kind: 'close' });
    a.t.close();
    expect(a.seen.close).toBe(1);
    expect(a.t.isOpen).toBe(false);

    const b = setup();
    await b.t.connect(secret);
    b.emit({ kind: 'open', maxChunk: 8 });
    b.t.close();
    b.t.close();
    expect(b.seen.close).toBe(1);
    expect(b.log.disconnects).toBe(1);
  });

  it('closes and reports when a write fails', async () => {
    const { t, emit, seen } = setup({ failWrite: true });
    await t.connect(secret);
    emit({ kind: 'open', maxChunk: 8 });
    t.sendJson({ v: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.errors.some((m) => /write failed/i.test(m))).toBe(true);
    expect(t.isOpen).toBe(false);
  });
});
