/*
 * "Why isn't it connecting?" Plain-language reasons, decided from facts the apps already have. Pure, so the table is
 * unit-tested; the apps only gather the facts and show the message.
 */

export interface ConnectionFacts {
  /** The connection service (Nostr relays / your relay) as the app sees it. */
  signaling: 'online' | 'connecting' | 'idle' | 'error';
  /** How many times we tried to connect to this friend since they last connected. */
  attempts: number;
  /** Seen anything from the friend (an offer, an answer, a "ready") during this attempt. */
  sawPeerReply: boolean;
  /** Kinds of addresses our own phone found while preparing the connection; null if unknown yet. */
  localCandidates: { host: number; srflx: number; relay: number } | null;
  /** The WebRTC connection's own verdict, if it got that far. */
  iceState: string | null;
  hasTurn: boolean;
  storeForward: boolean;
}

export type DiagnosisAction = 'enable-store-forward' | 'add-turn' | 'open-connection-settings';

export interface Diagnosis {
  code: 'no-signaling' | 'signaling-down' | 'no-answer' | 'no-public-address' | 'blocked-networks';
  message: string;
  actions: DiagnosisAction[];
}

/** Null while it is still early or nothing is wrong. */
export function diagnoseConnection(f: ConnectionFacts, friend = 'your friend'): Diagnosis | null {
  if (f.signaling === 'idle') {
    return {
      code: 'no-signaling',
      message: 'No connection service is set up, so phones across the internet cannot find each other. Turn one on in Settings > Connection.',
      actions: ['open-connection-settings'],
    };
  }
  if (f.signaling === 'error' || f.signaling === 'connecting') {
    if (f.attempts < 1) return null;
    return {
      code: 'signaling-down',
      message: "Can't reach the connection service (the relays). Check your internet, or add another relay in Settings > Connection.",
      actions: ['open-connection-settings'],
    };
  }
  if (f.attempts < 2) return null;
  const c = f.localCandidates;
  const failed = f.iceState === 'failed' || f.iceState === 'disconnected';
  const fallback: DiagnosisAction[] = f.storeForward ? [] : ['enable-store-forward'];
  if (c && c.srflx === 0 && c.relay === 0 && !f.hasTurn && c.host > 0) {
    return {
      code: 'no-public-address',
      message: `This phone could not find its public address (the address lookup is blocked on this network), so a direct link to ${friend} is not possible. A TURN server fixes this.`,
      actions: ['add-turn', ...fallback],
    };
  }
  if (failed || (f.sawPeerReply && f.attempts >= 3)) {
    return {
      code: 'blocked-networks',
      message: `${friend} answered, but the two networks would not let a direct link through. This is common on mobile data. A TURN server fixes it, and with store-and-forward on, messages still arrive through the relays in the meantime.`,
      actions: ['add-turn', ...fallback],
    };
  }
  if (!f.sawPeerReply) {
    return {
      code: 'no-answer',
      message: `${friend} has not answered. Make sure PrivCord is open on their device and that they are online.`,
      actions: fallback,
    };
  }
  return null;
}

/** Counts the address kinds in an SDP blob (host, srflx = found by STUN, relay = TURN). */
export function countSdpCandidates(sdp: string): { host: number; srflx: number; relay: number } {
  const out = { host: 0, srflx: 0, relay: 0 };
  for (const m of sdp.matchAll(/a=candidate:[^\r\n]* typ (host|srflx|relay)\b/g)) out[m[1] as 'host' | 'srflx' | 'relay'] += 1;
  return out;
}
