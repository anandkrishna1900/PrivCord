import { describe, expect, it } from 'vitest';
import { encodeBlob, type SealedBlob } from '@duochat/protocol';
import { HostedEngine, type EngineBridge } from '../engineBridge';
import type { PeerTransportHandlers } from '../p2p';
import { HostedRuntime, type LinkTransport, type RelayHub } from './runtime';

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeBridge() {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const bridge: EngineBridge = {
    start: async () => undefined,
    stop: async () => undefined,
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      return null;
    },
    on: async (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
  };
  return { bridge, calls, emit: (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((h) => h(payload)) };
}

class FakeTransport implements LinkTransport {
  isOpen = false;
  candidates = { host: 1, srflx: 1, relay: 0 };
  iceState: string | null = 'connected';
  sent: string[] = [];
  closed = false;
  failSend = false;
  answerFor: string | null = null;
  constructor(readonly handlers: PeerTransportHandlers) {}
  async createOffer() {
    return 'OFFER-SDP';
  }
  async acceptOffer(sdp: string) {
    this.answerFor = sdp;
    return 'ANSWER-SDP';
  }
  async applyAnswer() {
    this.isOpen = false;
  }
  sendText(text: string) {
    if (this.failSend) return false;
    this.sent.push(text);
    return true;
  }
  async drain() {
    return true;
  }
  async getStats() {
    return null;
  }
  close() {
    this.closed = true;
  }
}

const net = { state: 'connecting' as 'online' | 'connecting' };

class FakeHub implements RelayHub {
  puts: { mailbox: string; kind: string }[] = [];
  onBlob: ((blob: SealedBlob) => void) | null = null;
  mailbox = '';
  stopped = false;
  start(mailbox: string, onBlob: (blob: SealedBlob) => void) {
    this.mailbox = mailbox;
    this.onBlob = onBlob;
  }
  async put(mailbox: string, _blob: SealedBlob, opts: { kind: 'sig' | 'msg'; ttlSec: number }) {
    this.puts.push({ mailbox, kind: opts.kind });
  }
  status() {
    return net.state;
  }
  stop() {
    this.stopped = true;
  }
}

const blob = (): SealedBlob => ({
  v: 1, to: 'to', from: 'from', epk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, iv: 'iv', ct: 'ct', sig: 'sig',
}) as SealedBlob;

function setup(network: Record<string, unknown> = {}, extra: Partial<ConstructorParameters<typeof HostedRuntime>[0]> = {}) {
  const b = fakeBridge();
  const transports: FakeTransport[] = [];
  net.state = 'connecting';
  const hubs: FakeHub[] = [];
  let changed = 0;
  const runtime = new HostedRuntime({
    engine: new HostedEngine(b.bridge),
    network: () => network as never,
    rtcConfig: () => ({}),
    changed: () => (changed += 1),
    createTransport: (_rtc, handlers) => {
      const t = new FakeTransport(handlers);
      transports.push(t);
      return t;
    },
    createHub: () => {
      const h = new FakeHub();
      hubs.push(h);
      return h;
    },
    ...extra,
  });
  runtime.setOwnUid('aaa'); // lower than 'bbb': we are the initiator towards 'bbb'
  // `hub` is the hub of the mailbox the test subscribes to ('mb'); `state` moves every relay on or off line at once.
  const handle = {
    get state() {
      return net.state;
    },
    set state(v: 'online' | 'connecting') {
      net.state = v;
    },
    get puts() {
      return hubs.find((h) => h.mailbox === 'mb')?.puts ?? [];
    },
    get onBlob() {
      return hubs.find((h) => h.mailbox === 'mb')?.onBlob ?? null;
    },
    get stopped() {
      return hubs.find((h) => h.mailbox === 'mb')?.stopped ?? false;
    },
  };
  return { ...b, runtime, transports, hub: handle, changed: () => changed };
}

const sentSignals = (calls: { command: string; args: Record<string, unknown> }[]) =>
  calls.filter((c) => c.command === 'send_signal').map((c) => c.args);

describe('HostedRuntime dialing', () => {
  it('does not dial while the relays are not online, and does not use up the retry delay', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    expect(sentSignals(t.calls)).toHaveLength(0);
    expect(t.calls.some((c) => c.command === 'reset_dial_backoff' && c.args.peer === 'bbb')).toBe(true);
    t.runtime.stop();
  });

  it('offers when it is the initiator and the relays are online; answers an offer it receives', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    t.hub.state = 'online';
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    expect(sentSignals(t.calls)).toEqual([{ peer: 'bbb', kind: 'offer', sdp: 'OFFER-SDP' }]);

    t.emit('event', { SignalReceived: { peer: 'ccc', kind: 'Offer', sdp: 'THEIR-OFFER' } });
    await flush();
    expect(sentSignals(t.calls).at(-1)).toEqual({ peer: 'ccc', kind: 'answer', sdp: 'ANSWER-SDP' });
    expect(t.transports.at(-1)!.answerFor).toBe('THEIR-OFFER');
    t.runtime.stop();
  });

  it('with the shell owning the relay sockets, opens none and dials once the shell says they are online', async () => {
    let created = 0;
    const t = setup({}, { nativeSignaling: async () => false, createHub: () => ((created += 1), new FakeHub()) });
    await t.runtime.attach();
    t.runtime.setOwnUid('aaa');
    await flush();
    expect(created).toBe(0);
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    expect(sentSignals(t.calls)).toHaveLength(0);

    t.emit('signal-status', { online: true });
    expect(t.runtime.signalingStatus()).toBe('online');
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    expect(sentSignals(t.calls)).toEqual([{ peer: 'bbb', kind: 'offer', sdp: 'OFFER-SDP' }]);
    expect(created).toBe(0);
    t.runtime.stop();
  });

  it('makes no direct connection in private mode (Tor), whoever asks', async () => {
    const t = setup({ torMode: true });
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    t.hub.state = 'online';
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    t.emit('event', { SignalReceived: { peer: 'ccc', kind: 'Offer', sdp: 'THEIR-OFFER' } });
    await flush();
    expect(sentSignals(t.calls)).toHaveLength(0);
    expect(t.transports).toHaveLength(0);
    await expect(t.runtime.manualOffer('bbb')).rejects.toThrow(/private mode/);
    t.runtime.stop();
  });

  it('tells the engine when a link opens and when it closes', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    t.hub.state = 'online';
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    const transport = t.transports[0]!;
    transport.isOpen = true;
    transport.handlers.onOpen();
    await flush();
    const up = t.calls.find((c) => c.command === 'link_up')!;
    expect(up.args).toEqual({ peer: 'bbb', path: 'unknown', kind: 'encrypted' });
    expect(t.calls.some((c) => c.command === 'set_link_path')).toBe(true);
    transport.handlers.onFrame('incoming-frame');
    await flush();
    expect(t.calls.some((c) => c.command === 'frame_received' && c.args.frame === 'incoming-frame')).toBe(true);
    transport.handlers.onClose();
    await flush();
    expect(t.calls.some((c) => c.command === 'link_down' && c.args.peer === 'bbb')).toBe(true);
    t.runtime.stop();
  });
});

describe('HostedRuntime frames', () => {
  it('writes the engine\'s frames to the link in order, and closes the link when a write fails', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    t.hub.state = 'online';
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    const transport = t.transports[0]!;
    transport.isOpen = true;
    for (const f of ['one', 'two', 'three']) t.emit('frame', { peer: 'bbb', frame: f });
    await flush();
    expect(transport.sent).toEqual(['one', 'two', 'three']);

    transport.failSend = true;
    t.emit('frame', { peer: 'bbb', frame: 'four' });
    await flush();
    expect(transport.closed).toBe(true);
    expect(t.calls.some((c) => c.command === 'link_down')).toBe(true);
    t.runtime.stop();
  });

  it('shows progress for a file being sent as its frames are written', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    t.hub.state = 'online';
    t.emit('event', { DialRequested: { peer: 'bbb', initiator: true } });
    await flush();
    const transport = t.transports[0]!;
    transport.isOpen = true;
    transport.failSend = false;
    // Hold writes by making drain wait, so we can look in the middle.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    transport.drain = async () => {
      await gate;
      return true;
    };
    for (let i = 0; i < 4; i += 1) t.emit('frame', { peer: 'bbb', frame: `f${i}` });
    t.emit('event', { FileQueued: { peer: 'bbb', message_id: 'file-1', frames: 4 } });
    await flush();
    expect(t.runtime.progress.get('file-1')).toBe(0);
    release();
    await flush();
    expect(transport.sent).toHaveLength(4);
    expect(t.runtime.progress.has('file-1')).toBe(false); // finished: the bar is gone
    t.runtime.stop();
  });

  it('shows a file that is arriving, and removes the bubble when it is whole', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('event', { FileIncoming: { conversation: 'bbb', message_id: 'in-1', name: 'a.jpg', size: 10 } });
    t.emit('event', { FileProgress: { message_id: 'in-1', percent: 40 } });
    expect(t.runtime.incoming.has('in-1')).toBe(true);
    expect(t.runtime.progress.get('in-1')).toBeCloseTo(0.4);
    t.emit('event', { FileProgress: { message_id: 'in-1', percent: 100 } });
    expect(t.runtime.incoming.has('in-1')).toBe(false);
    expect(t.runtime.progress.has('in-1')).toBe(false);
    t.runtime.stop();
  });
});

describe('HostedRuntime relays', () => {
  it('waits for an online relay before publishing, and passes blobs that arrive to the engine', async () => {
    const t = setup();
    await t.runtime.attach();
    t.emit('signal-subscribe', { mailbox: 'mb' });
    const wire = encodeBlob(blob());
    t.emit('signal-put', { mailbox: 'mb', blob: wire, kind: 'live', ttlSec: 60 });
    await flush();
    expect(t.hub.puts).toHaveLength(0); // still connecting: held
    t.hub.state = 'online';
    await new Promise((r) => setTimeout(r, 250));
    expect(t.hub.puts).toEqual([{ mailbox: 'mb', kind: 'sig' }]);

    t.hub.onBlob?.(blob());
    await flush();
    expect(t.calls.some((c) => c.command === 'signal_blob' && c.args.mailbox === 'mb' && c.args.blob === wire)).toBe(true);

    t.emit('signal-unsubscribe', { mailbox: 'mb' });
    expect(t.hub.stopped).toBe(true);
    t.runtime.stop();
  });
});
