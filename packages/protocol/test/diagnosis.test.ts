import { describe, expect, it } from 'vitest';
import { countSdpCandidates, diagnoseConnection, type ConnectionFacts } from '../src';

const base: ConnectionFacts = {
  signaling: 'online', attempts: 3, sawPeerReply: true,
  localCandidates: { host: 2, srflx: 1, relay: 0 }, iceState: null, hasTurn: false, storeForward: false,
};

describe('connection diagnosis', () => {
  it('stays quiet while it is early or fine', () => {
    expect(diagnoseConnection({ ...base, attempts: 1 })).toBeNull();
    expect(diagnoseConnection({ ...base, attempts: 0, signaling: 'error' })).toBeNull();
    expect(diagnoseConnection({ ...base, sawPeerReply: true, attempts: 2, iceState: 'checking' })).toBeNull();
  });

  it('explains a missing or unreachable connection service', () => {
    expect(diagnoseConnection({ ...base, signaling: 'idle' })?.code).toBe('no-signaling');
    expect(diagnoseConnection({ ...base, signaling: 'error', attempts: 1 })?.code).toBe('signaling-down');
    expect(diagnoseConnection({ ...base, signaling: 'connecting', attempts: 2 })?.actions).toContain('open-connection-settings');
  });

  it('says the friend has not answered when nothing came back', () => {
    const d = diagnoseConnection({ ...base, sawPeerReply: false, iceState: null }, 'Ben');
    expect(d?.code).toBe('no-answer');
    expect(d?.message).toContain('Ben');
    expect(d?.actions).toEqual(['enable-store-forward']);
    expect(diagnoseConnection({ ...base, sawPeerReply: false, storeForward: true })?.actions).toEqual([]);
  });

  it('blames the address lookup when STUN found nothing, and the networks when ICE failed', () => {
    const noStun = diagnoseConnection({ ...base, localCandidates: { host: 2, srflx: 0, relay: 0 } });
    expect(noStun?.code).toBe('no-public-address');
    expect(noStun?.actions[0]).toBe('add-turn');
    const failed = diagnoseConnection({ ...base, iceState: 'failed' });
    expect(failed?.code).toBe('blocked-networks');
    expect(failed?.actions).toEqual(['add-turn', 'enable-store-forward']);
    // with a TURN server configured the "no public address" story is not told
    expect(diagnoseConnection({ ...base, hasTurn: true, localCandidates: { host: 2, srflx: 0, relay: 0 }, sawPeerReply: false })?.code).toBe('no-answer');
  });

  it('counts address kinds in an SDP', () => {
    const sdp = [
      'a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0',
      'a=candidate:2 1 udp 1686052607 49.36.1.2 50000 typ srflx raddr 192.168.1.5 rport 50000',
      'a=candidate:3 1 udp 41885439 13.1.1.1 3478 typ relay raddr 0.0.0.0 rport 0',
      'a=candidate:4 1 udp 2122194687 10.0.0.2 50001 typ host',
    ].join('\r\n');
    expect(countSdpCandidates(sdp)).toEqual({ host: 2, srflx: 1, relay: 1 });
    expect(countSdpCandidates('v=0')).toEqual({ host: 0, srflx: 0, relay: 0 });
  });
});
