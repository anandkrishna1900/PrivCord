/**
 * Who may chat directly with whom, for people who share a group.
 *
 * `verified`: we swapped invites with them ourselves (manual pairing). `introduced`: we only know them
 * through a group. The "stay group-only" setting stops direct chat with `introduced` people, from either
 * side, and never affects `verified` ones. Group messages are not covered by any of this.
 */
export type ContactTrustLevel = 'verified' | 'introduced';

/** May we start or continue a direct chat with them? `peerGroupOnly` is what they told us (unknown = false). */
export function canStartDirect(trust: ContactTrustLevel, myGroupOnly: boolean, peerGroupOnly: boolean | undefined): boolean {
  return trust === 'verified' || (!myGroupOnly && peerGroupOnly !== true);
}

/** Do we accept a direct message from them? Only our own setting matters on the receiving side. */
export function acceptsDirect(trust: ContactTrustLevel, myGroupOnly: boolean): boolean {
  return trust === 'verified' || !myGroupOnly;
}
