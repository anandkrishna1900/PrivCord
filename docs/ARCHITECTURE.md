# Architecture

PrivCord is an end-to-end encrypted messenger with no accounts and no required backend. This page
is the map; details live in the linked documents.

## Layers

| Layer | What it does | Where |
|---|---|---|
| **Identity** | A 12-word BIP-39 phrase derives the identity keys (ECDSA P-256 for signing, ECDH P-256 for key agreement). A user id is the fingerprint of the ECDH key. Same phrase, same identity, on any device. | `packages/protocol/src/recovery`, [IDENTITY_AND_RECOVERY.md](IDENTITY_AND_RECOVERY.md) |
| **Contacts** | A friend is a pinned identity card (exchanged by QR or invite text). `verified` = cards exchanged directly. `introduced` = learned from a group, added by a member. | `connectivity/contactCard.ts` |
| **Links** | One authenticated, encrypted channel per contact: WebRTC data channel, or Bluetooth LE with its own forward-secret channel. After connecting, both sides prove their keys match the pinned ones. Heartbeat detects dead links. | `peerAuth.ts`, `connectivity/secureChannel.ts`, [BLE_TRANSPORT.md](BLE_TRANSPORT.md) |
| **Finding each other** | Sealed (encrypted + signed) offers and answers delivered by signaling: public Nostr relays and/or your own relay, or through a mutual friend. Optional store-and-forward for offline friends. | `connectivity/seal.ts`, `relay/`, [CONNECTIVITY.md](CONNECTIVITY.md) |
| **Groups** | A group is a signed event log every member holds. Members can add members; the added member's card is the introduction, so everyone connects to them automatically. Messages go to each member over that member's own link. | `groups/`, [GROUPS.md](GROUPS.md) |
| **Storage** | Messages, contacts and group logs are stored locally with message text encrypted at rest. An outbox keeps unsent messages per recipient. | desktop `lib/localDb.ts`, Android Room |

## Data flow for one message

1. You send. The message is stored locally and queued once per recipient (one for a friend, one per
   member for a group).
2. For each recipient whose link is open, the message goes straight over that link and is acknowledged.
3. Everyone else stays queued; when their link opens (automatically, as soon as both are reachable)
   the queue is flushed. With store-and-forward on, a sealed copy can also wait on a relay.

## What servers can see

Nothing in this design needs a server that reads messages. The optional services are different roles
and are configured separately:

* **Signaling** sees sealed blobs addressed to a hashed mailbox: sizes and timing, never content.
* **STUN** sees your public address. **TURN** relays already-encrypted traffic and sees metadata.
* **A store-and-forward relay** holds sealed messages for offline friends (off by default).

The app is **not serverless**: across the internet it depends on whichever signaling, STUN and (in
strict networks) TURN you configure.

## Not implemented

Some building blocks exist in `packages/protocol` but nothing uses them yet: epoch group keys
(`e2ee/groupCrypto.ts`), the earlier (replaced) mesh router. Files are implemented in `files.ts` (8 MB, direct links only); open channels and
Bluetooth mesh relaying are in `mesh/` (see [CHANNELS_AND_MESH.md](CHANNELS_AND_MESH.md)).
