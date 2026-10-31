package com.duochat.app.data

/**
 * Who may chat directly with whom, for people who share a group. Port of packages/protocol/src/privacy.ts.
 *
 * VERIFIED: we swapped invites with them ourselves (manual pairing). INTRODUCED: we only know them through a
 * group. The "stay group-only" setting stops direct chat with INTRODUCED people, from either side, and never
 * affects VERIFIED ones. Group messages are not covered by any of this.
 */
fun canStartDirect(trust: ContactTrust, myGroupOnly: Boolean, peerGroupOnly: Boolean?): Boolean =
    trust == ContactTrust.VERIFIED || (!myGroupOnly && peerGroupOnly != true)

/** Do we accept a direct message from them? Only our own setting matters on the receiving side. */
fun acceptsDirect(trust: ContactTrust, myGroupOnly: Boolean): Boolean =
    trust == ContactTrust.VERIFIED || !myGroupOnly
