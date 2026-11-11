import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/snapshot.json';
import { shapeState, type ShapeContext, type SnapshotJson } from './shape';

const ctx = (over: Partial<ShapeContext> = {}): ShapeContext => ({
  ownName: 'Bob',
  signaling: 'online',
  signalingConfigured: true,
  hasTurn: false,
  storeForward: false,
  via: () => 'webrtc',
  facts: () => undefined,
  progress: new Map(),
  incoming: new Map(),
  phase: 'ready',
  error: null,
  notice: null,
  ...over,
});

// A real snapshot recorded from the Rust engine (see the WRITE_FIXTURE note in crates/privcord-desktop-host/tests).
const real = snapshot as unknown as SnapshotJson;

describe('shapeState on a real engine snapshot', () => {
  const state = shapeState(real, ctx());

  it('shows the friend as connected with the path the engine reported', () => {
    expect(state.uid).toBe(real.own_uid);
    expect(state.contacts).toHaveLength(1);
    const ann = state.contacts[0]!;
    expect(ann.name).toBe('Ann');
    expect(ann.trust).toBe('verified');
    expect(ann.conn).toBe('connected');
    expect(ann.path?.kind).toBe('direct-lan');
    expect(ann.status).toBe('Connected · Direct, same network');
    expect(ann.direct).toBe(true);
    expect(ann.last?.text).toBe('hello from the hosted engine');
  });

  it('carries the message with the fields the screens read', () => {
    const list = state.messages[state.contacts[0]!.uid]!;
    expect(list).toHaveLength(1);
    const m = list[0]!;
    expect(m.text).toBe('hello from the hosted engine');
    expect(m.own).toBe(false);
    expect(m.type).toBe('text');
    expect(m.senderName).toBe('Ann');
    expect(m.tick).toBe('DELIVERED');
    expect(m.conversationId).toBe(state.contacts[0]!.uid);
  });
});

describe('shapeState details', () => {
  const base = (): SnapshotJson => JSON.parse(JSON.stringify(real)) as SnapshotJson;

  it('explains an offline friend in words, and diagnoses a failing connection', () => {
    const s = base();
    s.contacts[0]!.link = 'Offline';
    expect(shapeState(s, ctx()).contacts[0]!.status).toBe('Waiting for Ann to come online');
    expect(shapeState(s, ctx({ signaling: 'error' })).contacts[0]!.status).toBe('Not connected');
    expect(shapeState(s, ctx({ signaling: 'idle', signalingConfigured: false })).contacts[0]!.status).toBe(
      'Not connected · no connection service is set up',
    );
    const withFacts = shapeState(
      s,
      ctx({ facts: () => ({ attempts: 3, sawPeerReply: true, localCandidates: { host: 1, srflx: 0, relay: 0 }, iceState: 'failed' }) }),
    );
    expect(withFacts.contacts[0]!.diagnosis).toBeDefined();
  });

  it('shows a file that is still arriving as a bubble with its progress, and drops it once the real message is there', () => {
    const s = base();
    const conv = s.contacts[0]!.uid;
    const incoming = new Map([['file-1', { conversation: conv, sender: conv, name: 'photo.jpg', size: 1000, since: 5 }]]);
    const mid = shapeState(s, ctx({ incoming, progress: new Map([['file-1', 0.4]]) }));
    const bubble = mid.messages[conv]!.find((m) => m.messageId === 'file-1')!;
    expect(bubble.type).toBe('file');
    expect(bubble.progress).toBe(0.4);
    s.conversations[0]!.messages.push({
      id: 'file-1', sender: conv, text: 'photo.jpg', created_at: 9, delivery: 'Delivered', reply_to: null,
      is_file: true, file_mime: 'image/jpeg', file_size: 1000, deleted: false, reactions: [], pending: 0, total: 0,
    });
    const done = shapeState(s, ctx({ incoming }));
    expect(done.messages[conv]!.filter((m) => m.messageId === 'file-1')).toHaveLength(1);
    expect(done.messages[conv]!.find((m) => m.messageId === 'file-1')!.file?.mime).toBe('image/jpeg');
  });

  it('labels channel senders with their chosen name and a short id, and hides muted people', () => {
    const s = base();
    s.channels = ['general'];
    s.channel_people = [{ uid: 'abcd1234', name: 'Alex' }, { uid: 'ffff0000', name: 'Spam' }];
    s.muted = ['ffff0000'];
    const row = (id: string, sender: string) => ({
      id, sender, text: id, created_at: 1, delivery: 'Delivered' as const, reply_to: null, is_file: false, file_mime: '',
      file_size: 0, deleted: false, reactions: [], pending: 0, total: 0,
    });
    s.conversations.push({ id: 'chan:general', messages: [row('m1', 'abcd1234'), row('m2', 'ffff0000')], last: null, unread: 0 });
    const state = shapeState(s, ctx());
    const list = state.messages['chan:general']!;
    expect(list.map((m) => m.messageId)).toEqual(['m1']);
    expect(list[0]!.senderName).toBe('Alex #abcd');
    expect(state.channels[0]!.id).toBe('chan:general');
    expect(state.channels[0]!.conn).toBe('connected');
  });

  it('turns an answered invite, requests and the invite words into the screens\' shapes', () => {
    const s = base();
    s.invite = { words: 'one two three four five six', expires_at: 99 };
    s.requests = [{ uid: 'abcdef123456', name: '', safety_number: '12345' }];
    s.answer = { uid: s.contacts[0]!.uid, status: 'Failed' };
    const state = shapeState(s, ctx());
    expect(state.invite).toEqual({ words: 'one two three four five six', expiresAt: 99 });
    expect(state.requests[0]!.name).toBe('Friend abcdef');
    expect(state.answer?.status).toBe('failed');
  });
});
