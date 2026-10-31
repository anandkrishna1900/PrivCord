# Contacts, groups and automatic introductions

Reference implementation and tests: `packages/protocol/src/groups/` and
`packages/protocol/test/groups.test.ts`. Desktop and Android implement the same rules.

## 1. Model

* **Contact**: someone we hold a verified identity card for. Trust level:
  * `verified`: we exchanged cards (QR / invite text) with them in person or over a channel we trust.
  * `introduced`: we learned their card from a group roster, added by an existing member
    (`introducedBy`). Their keys are pinned, so connections to them are cryptographically
    authenticated, but nobody checked the safety number. The UI says "Introduced by NAME" and offers
    "Verify" (safety number) which upgrades the contact to `verified`.
* **Group**: a signed, append-only event log (`create`, `add`, `remove`, `rename`). Every member holds
  the full log. The roster is a deterministic fold, so every member computes the same roster.
  There is no group server and no shared group key. A group message is sent to every other member
  over that member's own authenticated pairwise channel (WebRTC, Bluetooth, or sealed relay).
* **Who may do what**: any member can add a member. Only the group's admin (its creator) can remove
  others or rename. Anyone can leave. Concurrent conflicts resolve as "remove wins". Events from
  non-members, with bad signatures, or with a card that does not match the claimed uid have no effect.

## 2. Introduction flow (no code sharing)

A creates a group with B (A and B met). B adds C (B and C met).
1. B signs `add(C, cardC)` and sends the full log to C and the event to A.
2. A verifies B's signature against B's card from the roster, applies the event, and gets
   `newContacts: [C introduced by B]`. C gets the full log: the cards of A and B, so C pins A as
   `introduced by B`. (Both sides now hold each other's pinned keys.)
3. Both engines see a contact with no link and start the normal automatic connection (signaling
   hub / Nostr / relay, or via a mutual contact with `relay_blob`). The usual hello/auth handshake
   runs and passes because both sides pinned the keys. No QR, no code, no manual step.
4. Result: a full mesh. Everyone ends up linked to everyone in the group.

### Size limit
A group has at most `MAX_GROUP_MEMBERS = 10` members including the creator. The roster fold ignores an
`add` that would exceed it, in the same deterministic order on every replica, so concurrent adds still
converge. Authoring refuses early ("This group is full"), as does creating a group of 11.

### Group-only privacy opt-out
By default people you meet through a group can message you directly (that is the introduction). Each
user has a setting **"Stay group-only with people I meet in groups"** (off by default). Rules:

* A direct chat with an `introduced` contact exists only if **neither** side has the setting on.
  `canDirect(uid) = trust == verified || (!myGroupOnly && peer != groupOnly)`.
* Contacts you paired yourselves (swapped invites, `trust = verified`) are never affected, so two people
  can always pair manually to chat directly even if one of them stays group-only.
* Group messages, replies, files and the group roster are unaffected: the pairwise link still exists
  (it carries the group's messages), only direct chat is off.
* Each side sends `privacy {groupOnly}` after authentication and whenever the setting changes, so both
  UIs hide the direct chat without a failed send. Receiving enforces it regardless: a direct `message`
  or `file_offer` from an introduced contact while *we* are group-only is refused with
  `declined (direct_not_accepted)`.
* Group-only people are not offered when adding members to another group, so their identity is not
  spread through you. Safety-number checks (`setChecked`) are separate and do not change any of this.

## 3. Wire frames (over an authenticated pairwise channel; see `parseGroupFrame`)

| Frame | Meaning |
|---|---|
| `group_push {event}` | One new event. Receiver applies it and re-gossips it to other members. |
| `group_events {events[<=40]}` | A batch (full history for a new member, or a sync reply). |
| `group_have {groups:[{groupId, ids[]}]}` | "These are the events I have." Sent on every link open and when events arrive out of order. Receiver replies with what the sender lacks, **only for groups the sender belongs to**. |
| `gmsg {groupId, messageId, text, clientCreatedAt}` | A group chat message. Sender identity = the channel's authenticated peer. |
| `relay_blob {blob, hops<=2}` | Pass a sealed signaling blob to another contact we are linked to (introduction without internet). |

Existing direct-chat frames (`message`, `ack`, `read`, `ping`, `pong`) are unchanged except that
`message` and `gmsg` accept an optional `replyTo {id, author, preview<=120}`. New frames:

| Frame | Meaning |
|---|---|
| `declined {messageId, reason}` | The receiver refused (`direct_not_accepted`, `too_large`, `bad_file`, `busy`). |
| `file_offer {messageId, groupId?, name, mime, size<=8 MiB, sha256, clientCreatedAt, replyTo?}` | Starts a file transfer. |
| `file_chunk {messageId, index, data}` | 12 KiB of the file, base64url, strictly in order. |

Files: sent to each recipient over the already-authenticated WebRTC link (not Bluetooth, not the relay),
paused while the channel's send buffer is full. The receiver checks size, order and SHA-256 and then
sends the normal `ack`. At most 2 incoming transfers per peer; a stalled one is dropped after 30 s.
Names are sanitised, MIME types are validated, and only PNG/JPEG/GIF/WebP images and MP4/WebM/QuickTime/Ogg videos are previewed. Acks work for
group messages too (`messageId` is globally unique).

## 4. What every engine must do

1. **Many links.** One authenticated link per contact (not just one). The signaling hub keeps one
   mailbox for us; incoming sealed blobs are opened with the sender's pinned key looked up by `blob.from`.
   Initiator rule is per pair (lower uid offers). Backoff per contact (5 s doubling to 120 s).
   At most 3 connection attempts in flight; soft cap of 30 simultaneous links (document it in the UI).
2. **On link open (authenticated):** send `coordinator.onLinkOpen(peerUid)` frames, flush that
   contact's queued messages, resume heartbeat.
3. **On `GroupResult`:** deliver `outgoing` frames to peers with an open link (others are repaired by
   sync); for each `newContacts` entry pin the card as `introduced` and start connecting;
   `joined`/`left`/`changed` update the UI ("X added you to GROUP").
4. **Sending a group message:** one outbox row per recipient (`coordinator.recipients(groupId)`),
   delivered when that contact's link is up, acked per recipient. Show a single bubble; its tick is the
   weakest recipient state, with a "Delivered to 3 of 5" detail.
5. **Receiving a group message:** `coordinator.checkMessage(from, groupId)`. `ok` stores and acks.
   `unknown_group`/`not_member`: hold it up to 60 s, send `requestSync(from, groupId)`, re-check after
   events arrive, then drop. Dedupe by `messageId`. Only messages sent after we joined are shown
   (no history is handed to new members).
6. **Persistence:** contacts (card, trust, introducedBy, nickname), `coordinator.export()` per group,
   conversations keyed by contact uid or groupId. Messages carry `conversationId` and `senderId`.
7. **Removal:** on `left` the group stays visible, read-only, labelled "You were removed" / "You left".
8. **Never** accept group frames on an unauthenticated or unverified link.

## 5. UI rules (first-time friendly)

* No jargon: no "uid", "epoch", "signaling", "safety number" on primary screens. Use "friend",
  "invite", "connected / waiting for NAME".
* Home = one list of chats (people and groups) with last message, unread dot and a connection dot.
  Two clear actions: **Add friend** and **New group**.
* **Add friend** is one screen: "Show my invite" (QR + Copy) and "Scan or paste a friend's invite".
  Then an optional "Check it's really them" step with the numbers; "Skip for now" is allowed and the
  contact is kept as `verified`-by-card. (The 6-word code is removed: it cannot carry keys.)
* **New group**: name, choose friends (checkboxes), Create. In a group: Members list with "added by",
  Add member (pick from your friends), Leave. Admin sees Remove.
* Introduced people show a small "Introduced by NAME" line and a "Verify" action.
* Chat header: name, one status line in plain words, one "..." menu (details, verify, mute,
  clear chat). Dangerous actions (wipe) live in Settings > Security only.
* Remove anything that does not work yet. Each bubble has a Reply button; the composer has a paperclip (also drag and drop, paste).
* Settings: Profile, Connection (status + "Advanced" collapsed: STUN/TURN/relays/Bluetooth),
  Security (recovery phrase restore, wipe), About.

## 6. Limits and honesty

* Full mesh: N members means N-1 links per device. Simulated to 25 members (identical rosters,
  every pair linked); real-browser tests use a handful. Phones may struggle well before 30.
* A member who is introduced is trusted for **messaging in that group and for direct chat**; a
  malicious introducer could introduce an impostor. That is why introduced contacts are labelled
  and verifiable.
* Group messages inherit pairwise channel security (end-to-end, forward-secret on Bluetooth and
  WebRTC DTLS). Removal does not erase what removed members already received.
* If a message is for a member we are not linked to yet it is queued and sent when the link opens.
