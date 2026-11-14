# Sync engine: one account on several devices, with no server

Status: **steps 1–4 built; steps 5–10 to come.** See [§16](#16-what-is-built) for exactly what runs today.
Scope: the Rust engine (`crates/privcord-*`). Android, Windows, macOS and Linux get it through thin platform adapters, as
they get the rest of the engine. The TypeScript engine (browser preview) does not sync (risk 128).

## 1. Goal

A person uses DuoCord on a phone and a laptop (up to 5 devices). Whatever they do on one device — send, receive, reply,
react, edit, delete, read, mute, pin, block, join a group — appears on the others **exactly as it happened**, with no
context lost, even when:

- the devices are never online at the same time;
- no background service runs on either of them;
- relays lose, reorder, replay or withhold data;
- the app is killed mid-sync, clocks are wrong, storage is low, versions differ.

…and the live chat never gets slower because sync is running.

There is no server. Relays are untrusted, interchangeable storage for encrypted data. Having no server is meant to be an
advantage: nobody can read or hand over the data, devices sync directly at local-network speed, it works without the
internet (Bluetooth, local Wi-Fi), and there is no company that can switch it off.

### The one limit that applies to every chat app

If a device has no network at all, nothing leaves it, and another device cannot learn about it until the two meet. What
this design guarantees is narrower and achievable:

> **Invariant 1 (sent means synced).** A message counts as sent only when it has been delivered to the recipient
> **and** a copy for the sender's other devices has been durably stored (in the self-mailbox on at least 2 relays, or
> confirmed by another of the sender's devices).

> **Invariant 2 (catch up before showing).** When the app opens, it fetches the self-mailbox first and merges it, then
> shows the chats. Missing items slot in as they arrive; the app never blocks on them.

Together these make the "phone, then laptop, then phone, with no background sync" case lossless: whatever the phone sent
was online at that moment, so its sync copy went up with it, and the laptop collects it on open.

## 2. Identity: account and devices

Today a user's id is derived from one device's keys (`uid_from_keys`). Multi-device separates the two:

- **Account root.** Derived from the existing 12-word recovery phrase (see `IDENTITY_AND_RECOVERY.md`). It signs the
  device list and nothing else day to day. It stays sealed in the platform keystore of the first device and is otherwise
  only re-derived from the phrase for rare actions (risks 45, 103).
- **Device keys.** Each device has its own signing key and its own hybrid key-agreement keys (P-256 + ML-KEM-768, as
  today), its own one-time prekeys (risk 50), and a **device certificate** signed by the account root.
- **Device list.** A versioned, account-signed record: device id, public keys, name (model + link date), added/removed
  epochs. Friends verify it against the account key. Only the account key can change it (risks 18, 28, 108).
- **Safety number** covers the account key only. A device change shows a separate, quieter notice (risk 51).
- **Migration (risk 40).** The current identity becomes the account root and the current device its first device, so
  every contact keeps working without re-pairing. Old friends who do not understand device lists keep talking to the
  first device; its own sync carries everything to the others (risk 41).
- **Cap:** 5 devices (risk 106). Group size caps count people, not devices (risk 54).

### Linking a device

1. The existing device shows a QR code (or a manual code, risk 110) carrying a one-time link key.
2. The new device connects over the best available route (local Wi-Fi, Bluetooth, internet relay).
3. **Both screens show a short code that must match** (risk 24).
4. The existing device issues the device certificate; the account-signed device list is bumped and announced to own
   devices and to friends.
5. Bulk history transfer starts (§6), newest first. Live sync and the import meet at a recorded boundary, and entries
   are deduplicated by id (risk 66).

Two links at once: the device list version serialises them; the second waits (risk 108).

### Removing a device

- From a trusted device: announced to every device immediately, effective after **24 hours**, cancellable from any
  trusted device. With the recovery phrase: immediate (risks 45, 104).
- On removal: device list bumped; 1:1 session keys to that device dropped; **group sending keys rotated** (risk 53);
  self-mailbox epoch key rotated (§5); messages in flight to the old keys get a short grace window and are re-sent from
  the log (risk 52); a signed "wipe" is queued for when the device next connects, with the interface saying plainly this
  cannot be guaranteed (risk 93).
- A stolen device cannot remove the others silently: removal by a device is delayed and visible, and only the phrase is
  instant.

## 3. The sync log

Every durable change is an **entry** in the authoring device's append-only log.

```
Entry {
  device:   DeviceId            // author device
  series:   u32                 // numbering series; new after restore or clone detection (risks 15, 48, 90)
  seq:      u64                 // 1, 2, 3 … per (device, series), no gaps
  prev:     [u8; 32]            // hash of the previous entry in this series (hash chain, risks 26, 27)
  clock:    Hlc                 // hybrid logical clock for ordering (risks 4, 14)
  kind:     EntryKind           // see below; unknown kinds are kept verbatim (risk 47)
  durable:  bool                // ephemeral kinds are never logged (risk 64)
  body:     bytes               // canonical encoding (risk 56)
  sig:      Signature           // device signature over all of the above (risks 23, 55)
}
```

- **Numbering.** The counter is persisted *before* the entry leaves the device (risk 15). Two different entries with
  the same `(device, series, seq)` are proof of a cloned device: that device id is frozen and must relink (risk 48).
- **Forwarding.** Entries are forwarded with the author's original signature, never re-signed (risk 55).
- **Unknown kinds** from newer versions are stored and forwarded byte for byte (risk 47).
- **Canonical encoding** is one byte-exact format with shared test vectors in CI (risk 56).

### Entry kinds (initial)

| Kind | Merge rule |
|---|---|
| `Message` (own sent message, or a friend's message as received — the **original signed frame**, byte for byte) | Set, deduplicated by message id (risk 101) |
| `Reply`, `Reaction` | Point at the target message by id; held as pending if the target is missing (risks 7, 58, 70) |
| `Edit` | Kept in a fixed order; the latest is shown, history viewable (risk 62) |
| `DeleteForEveryone`, `DeleteForMe` | Separate kinds with different recipients (risk 63); delete beats edit; remembered so late arrivals stay hidden (risks 8, 11) |
| `ReadMark` | Maximum per conversation; only moves forward (risk 21) |
| `Setting` (mute, pin, block, nickname, relay list, …) | Per-key latest-wins by clock; each setting is marked synced or per-device (risks 119–121) |
| `Block` | As `Setting`, but synced with top priority (risk 60) |
| `Group*` | Existing signed group events, ordered (risk 18) |
| `MediaRef` | File hash root, file key, size, type, small thumbnail, duration/waveform for voice (risks 72–75, 117) |
| `Contact` | Add/remove; sending to a removed contact re-adds them, visibly (risk 61) |
| `SecurityNotice` | Device linked/removed, keys changed; shown on every device when it next opens (risk 112) |
| `LostMarker` | Signed by the account: entries `(device, series, a..b)` are unrecoverable (risk 49) |
| `Correction` | A signed fix for entries written by a buggy release; entries themselves never change (risk 123) |
| `Snapshot` | See §7 |

Ephemeral things (typing, presence, drafts, app-lock state, theme, notification sound) are never logged (risks 64, 65,
119).

### Ordering and convergence

- Display order: by `(clock, author device, seq)`, so every device shows the same order (risks 3, 17).
- Hybrid logical clocks ignore large wall-clock errors; timestamps further than a small bound into the future are capped
  (risk 14).
- A late entry is inserted without moving the user's scroll position, and marked with the device it came from (risk 69).
- **State fingerprint.** Each device maintains, as it writes, an incremental hash tree over its *original* chat state
  (risk 115). Derived data — thumbnails it generated itself, search index, transcodes — is excluded (risk 114). Text and
  emoji are normalised first (risks 57, 116). After a sync session the two devices compare fingerprints; a mismatch
  triggers a repair sync that compares per-conversation subtrees (risk 10).

### Pending entries

Entries whose dependency (target message, earlier group event) has not arrived wait in a bounded area. Past the bound,
a placeholder is shown and the entry is dropped from memory; it is retried when the dependency arrives (risk 58).

### Applying entries never crashes

An entry that fails to validate or apply is **quarantined** and reported, never retried in a loop and never allowed to
crash the engine. The apply path is fuzzed in CI with the existing fuzzing setup (risk 98).

## 4. Delivery to friends' devices

- A message is encrypted once per recipient device (1:1). Groups encrypt once for the group with each sender device's
  own group sending key (risks 54, 97).
- **Each pair of devices has its own encryption session.** Session and group-key ratchet state is never synced between
  own devices (risks 96, 97). Only message contents sync, through the log.
- **Nonces** are random (XChaCha20-Poly1305) or derived from a unique `(device, series, seq)`; never from a counter that
  a restore can reset (risk 100).
- The friend's app queues a message until **at least one** of the recipient's devices confirms it; per-device retries
  back off independently, so a dead device does not slow anything (risk 7). The recipient's own devices then pass it
  along through their logs.
- Ticks: delivered = any of their devices; read = any of their devices; per-device detail on long-press (risk 71).
  Exactly one read receipt is sent per message (risk 105).
- A friend with an outdated copy of your device list is told about changes directly by your devices; anything they
  missed reaches your new device through your own sync (risk 109).

## 5. The self-mailbox (relays as untrusted storage)

- Every entry is also posted, encrypted, to the account's **self-mailbox** on 2–3 relays (the user's own relay plus
  public ones).
- Encryption: per-epoch keys derived from the account, rotated regularly and on device removal; old epoch keys are
  deleted once every device has confirmed the epoch (risk 46).
- Mailbox labels are keyed hashes (HMAC) of the account and epoch, so relays cannot link mailboxes over time; entries are
  padded to fixed sizes and posted with small random delays (risk 25).
- Relays cannot read (encrypted), forge (signed), reorder or replay undetected (hash chain + numbering), or withhold
  undetected (gaps) — a gap is fetched from another relay or device (risks 5, 26, 27).
- Size: entries are capped and split to fit relay event limits; media never goes through public relays (risks 2, 3).
- Rate: sync has a per-relay budget that always leaves headroom for live messages (risk 2).
- **Relay list is a synced setting.** Linking merges both lists. After a change, old relays stay readable for a
  transition period. The interface warns when a device shares no relay with the others (risk 99).
- Retention is measured per relay; the interface warns when only short-lived relays are configured, and recommends the
  user's own relay (risk 127).
- With several devices the self-mailbox is the hub: one announcement per change, not one per device pair (risk 107).
- Writes are signed by the device and verified before storing; processing per relay is capped against floods (risk 76).

## 6. Sync sessions between devices

When two own devices can reach each other (local Wi-Fi, Bluetooth, internet), or a device reads the self-mailbox:

1. Exchange **summaries**: for each `(device, series)`, the highest contiguous `seq` held. A few hundred bytes.
2. Request exactly the missing ranges. If two devices both have gaps, the one with the lower device id leads the session
   and the other only answers (risk 5).
3. Apply in **one database transaction per batch** (risk 16). Replaying an entry is harmless. Batches are short, so the
   interface's own read connection never stalls (risk 84).
4. Compare fingerprints (§3).

Large history (new device, a device back after months) is transferred newest first: newest text, then read state, then
older text, then media (risks 9, 16, 125). Reconciliation has a bounded depth and a time budget per session (risk 79).

A device unseen for 90 days is shown in settings with "Remove or reconnect" and a reminder (risk 113); it must relink to
rejoin if snapshots have moved past it (risk 13).

A permanent gap (author device died before uploading) is closed after a timeout by an account-signed `LostMarker`, and
the interface says "1 item from Phone could not be recovered" (risk 49).

## 7. Snapshots and pruning

- A device periodically writes a signed snapshot of the merged state.
- Old entries are pruned only after **every** device has confirmed the snapshot (risks 12, 13).
- Pruning never removes anything still referenced by a kept entry (risk 59).
- A snapshot may only be written by a device that understands every entry kind present; otherwise none is made
  (risk 47).
- Deletion records are dropped only once covered by a confirmed snapshot (risk 12).

## 8. Media

- Files are addressed by a hash tree (root in `MediaRef`); every chunk is checked against it, so chunks can come from any
  untrusted source — another own device, a relay, a nearby device (risk 29).
- Each file has its own random key. Duplicates are merged in local storage only, never visibly on relays (risk 73).
- Sources in order: a nearby own device on local Wi-Fi, then Bluetooth, then the user's own relay. Chunks are served only
  to authenticated own devices, with rate limits (risk 78).
- Chunks stream straight to disk (risk 75); a file is written to a temporary name, verified, then renamed into place
  (risk 74).
- A device keeps media it sent until another device confirms having it; if the last copy is gone, the bubble says
  "media no longer available" (risk 72).
- The original bytes are synced; conversion happens only for playback (risk 117). Location data is stripped before
  sending, and the stripped file is what the sender's own devices keep too (risk 118).
- Low storage: text and thumbnails are kept, full media is dropped first and fetched again when opened; free space is
  checked before writing (risks 15, 36).
- Media waits for Wi-Fi by default and respects Android Data Saver (risk 6). Over Bluetooth only text and summaries
  travel (risk 8). In private mode only text syncs over Tor; media waits for local Wi-Fi (risk 82).

## 9. Transport and priority

Three lanes, strictly prioritised, in the engine (shared by every platform):

| Lane | Carries |
|---|---|
| 1. Live | texts, reactions, replies, receipts, typing |
| 2. Sync | summaries, small entries, security notices, blocks |
| 3. Bulk | media chunks, history backfill |

- On WebRTC, bulk travels on a **separate data channel**, in small chunks, so a text is never queued behind a file
  (risk 1).
- Lane 3 only uses what lanes 1–2 leave free, pauses while the user is actively chatting and on mobile data, and slows
  on low battery or battery saver (risks 6, 38).
- After a long outage, reconnects are spread out with random delays (risk 4).
- Local-network discovery falls back to a direct internet connection, then the relay, when the network blocks it
  (risk 9).
- Privacy modes:
  - **Private mode (Tor):** no local-network announcements; local sync only after a QR or manual pairing (risk 80).
  - **Hide my IP from friends:** own devices may still connect directly. This follows the user's setting and is said so
    plainly (risk 81).
  - **Bluetooth mesh:** carries only encrypted, padded data; sync entries travel by mesh only between own devices
    (risk 83).

## 10. The background runner

One engine, the same on every platform; platforms provide only adapters (radio, network, keystore, notifications,
battery and screen state).

- **Background policy (Rust).** Inputs: battery level, charging, network type (Wi-Fi / mobile / none / metered),
  screen on/off, app in foreground, Data Saver. Outputs: which lanes may run, Bluetooth scan rate, relay keep-alive
  interval, whether bulk may run. Every background job has a time limit and always releases what it holds awake
  (risk 87).
- **Desktop (Windows, macOS, Linux):**
  - Tray icon. Closing the window hides it to the tray; the web view is torn down and only the engine runs.
  - Notifications are sent from Rust.
  - Optional start at login.
  - Single-instance lock: a second launch focuses the first window (risk 35).
  - On wake from sleep, the time jump is detected and connections are re-made (risk 86).
  - If the engine crashes, opening the window restarts it, and the crash is logged (risk 34).
- **Android:** the existing foreground service (remoteMessaging) runs the same engine; nothing new is needed to keep it
  alive. Doze can delay it for hours: catch-up on open (Invariant 2) is the guarantee and background sync is a bonus
  (risks 32, 33, 88).
- **Locked database (app lock not yet passed):** incoming entries go to a separate encrypted inbox and are merged after
  unlock (risk 37).
- **Notifications:** every device notifies; reading on one clears the others through fast read-mark sync (risk 68).
  Quick reply from the notification is a later addition.
- **Database:** WAL mode, short transactions, batched writes (risk 126); space is reclaimed gradually when idle and
  charging (risk 85); schema upgrades run before the queue is processed, and queued entries record their version
  (risk 89).

## 11. Backups

- Entries are deduplicated by id on restore, and a restored device starts a new numbering series (risk 90).
- A backup never contains device keys; restoring always means linking as a new device (risk 91).
- Device keys and the database are excluded from Android's own automatic app-data backup (risk 48).
- Automatic backups run from one chosen device by default (risk 92).

## 12. Interface

- Each device shows "Up to date with <device>" or "Missing N items" (risk 42).
- Removing a device warns first; history on other devices is untouched (risk 43).
- Device names include model, link date and last seen (risk 111).
- Search indexes text as it syncs; media is indexed by name and caption until downloaded. The index is never synced
  (risks 44, 124).
- A disappearing message reaching a device after expiry is never shown; relays keep it no longer than its timer
  (risks 20, 122).
- Open channels: only membership syncs, not content (risk 67).
- A shared computer: each OS user account has its own encrypted database (risk 94).
- Onboarding makes saving the recovery phrase very clear and offers automatic backups (risk 95).

## 13. Risk register

Every row below has an automated test before the feature it belongs to ships (§14). Section numbers point at the part
of the design that handles it.

### Transport and speed

| # | Risk | Handled in |
|---|---|---|
| 1 | Bulk transfer queued ahead of a text on an ordered channel | §9 separate bulk channel, lanes |
| 2 | Relay rate limits drop live messages | §5 budget, §9 |
| 3 | Relay event size limits | §5 split entries; media off public relays |
| 4 | Sync storm after an outage | §9 jittered reconnects, §6 newest first |
| 5 | Two devices sync the same gap from each other | §6 lower id leads |
| 6 | Mobile data use | §8 Wi-Fi by default, Data Saver |
| 7 | One unreachable device slows sending | §4 per-device backoff, any-device confirmation |
| 8 | Bluetooth too slow for history | §8 text and summaries only |
| 9 | Local discovery blocked | §9 fallbacks |

### Consistency

| # | Risk | Handled in |
|---|---|---|
| 10 | Merge bug makes devices disagree forever | §3 fingerprint + repair |
| 11 | Delete and edit race | §3 delete wins, remembered |
| 12 | Deletion records pile up | §7 |
| 13 | Snapshot while a device is offline | §6, §7 confirmation, 90-day rule |
| 14 | Clock far in the future | §3 HLC, cap |
| 15 | Numbering reused after crash or restore | §3 persist first, new series |
| 16 | Half-applied sync | §6 transaction per batch |
| 17 | Device deleted then relinked re-imports history | §2 fresh device id |
| 18 | Group membership out of sync | §3 signed ordered group events |
| 19 | Reaction to a deleted message | §3 hidden / "message deleted" |
| 20 | Disappearing timers differ | §12 expiry fixed at send |
| 21 | Read marks flicker | §3 maximum only |

### Security

| # | Risk | Handled in |
|---|---|---|
| 22 | Stolen phone still linked | §2 removal |
| 23 | Linked device writes fake history | §3 per-device signatures |
| 24 | Linking intercepted | §2 matching short code |
| 25 | Relays learn from timing | §5 keyed labels, padding, delays |
| 26 | Replay of old entries | §3 numbering + hash chain |
| 27 | Relay withholds entries | §5 gap detection |
| 28 | Friend's device list spoofed | §2 account-signed list |
| 29 | Corrupt media from an untrusted source | §8 hash tree |
| 30 | Downgrade to a non-syncing protocol | Version pinned at link; no fallback |
| 31 | Account key compromise | §2 keystore; re-rooting is explicit and visible |

### Devices and platforms

| # | Risk | Handled in |
|---|---|---|
| 32 | Android kills the service mid-sync | §6 transactions, resume |
| 33 | Doze delays wakeups | §10 catch-up on open |
| 34 | Tray process crashes | §10 |
| 35 | Two instances on one PC | §10 single-instance lock |
| 36 | Low storage | §8 |
| 37 | Database locked by app lock | §10 encrypted inbox |
| 38 | Battery saver | §9, §10 policy |
| 39 | Big first sync on a weak device | §6 paced, low priority, paged reads |

### Users and migration

| # | Risk | Handled in |
|---|---|---|
| 40 | Moving existing users to account keys | §2 migration |
| 41 | Friend on an old version | §2 first device carries it |
| 42 | Not knowing whether sync is done | §12 status line |
| 43 | Removing a device by mistake | §12 warning |
| 44 | Search before media is fetched | §12 |

### Cryptography and identity (deeper)

| # | Risk | Handled in |
|---|---|---|
| 45 | Stolen device removes your other devices | §2 delayed removal, phrase override |
| 46 | History sync weakens forward secrecy | §5 epoch keys deleted; history re-encrypted per target device |
| 50 | Devices sharing one-time prekeys | §2 per-device prekeys |
| 51 | Safety number churn | §2 account-only safety number |
| 52 | Messages in flight to a removed device's key | §2 grace window, re-send |
| 53 | Removed device holds group key | §2 rotate group keys |
| 54 | Group cap counts devices; fan-out cost | §2, §4 |
| 55 | Re-signing forwarded entries | §3 original signature kept |
| 56 | Different encodings per platform | §3 canonical encoding, vectors |
| 57 | Unicode normalisation breaks fingerprints | §3 |

### Consistency (deeper)

| # | Risk | Handled in |
|---|---|---|
| 47 | Older version makes a lossy snapshot | §3 unknown kinds kept, §7 |
| 48 | One device id on two machines | §3 clone detection, §11 backup exclusion |
| 49 | Permanently lost gap | §6 `LostMarker` |
| 58 | Pending entries fill memory | §3 bounded area |
| 59 | Snapshot prunes a referenced message | §7 |
| 60 | Block not yet synced | §3 top priority |
| 61 | Contact deleted on one device, messaged on another | §3 visible re-add |
| 62 | Concurrent edits | §3 ordered edit history |
| 63 | Delete-for-me vs delete-for-everyone | §3 separate kinds |
| 64 | Ephemeral data logged | §3 durable flag |
| 65 | Drafts overwrite each other | §3 per device, not synced |
| 66 | Duplicates during new-device import | §2 boundary, dedupe |
| 67 | Channels flood own devices | §12 membership only |

### Notifications and display

| # | Risk | Handled in |
|---|---|---|
| 68 | Every device notifies | §10 cleared by read sync |
| 69 | Late message scrolls the view | §3 stable insert, device label |
| 70 | Reply before its original | §3 pending + quoted preview |
| 71 | Ambiguous ticks | §4 |

### Media

| # | Risk | Handled in |
|---|---|---|
| 72 | Last copy deleted | §8 keep until confirmed |
| 73 | Deduplication leaks equality | §8 per-file keys |
| 74 | Corrupt file after a kill | §8 temp + verify + rename |
| 75 | Large file held in memory | §8 stream to disk |

### Abuse

| # | Risk | Handled in |
|---|---|---|
| 76 | Junk flood into the self-mailbox | §5 verify before store, caps |
| 77 | Absurd declared sizes | Size checks before allocating; fuzzed |
| 78 | Battery-drain chunk requests | §8 authenticated, rate-limited |
| 79 | Crafted summaries slow reconciliation | §6 bounded depth, time budget |

### Privacy modes

| # | Risk | Handled in |
|---|---|---|
| 80 | Local announcements in private mode | §9 |
| 81 | Own-device direct links under "hide my IP" | §9 |
| 82 | Bulk over Tor | §8 text only |
| 83 | Mesh carries sync past strangers | §9 |

### Storage and platforms (deeper)

| # | Risk | Handled in |
|---|---|---|
| 84 | Write lock contention | §6, §10 |
| 85 | Database file growth | §10 |
| 86 | Sleep/hibernate mid-transfer | §10 |
| 87 | Wake locks leaked | §10 time limits |
| 88 | Harsher background limits (future iPhone) | §10 catch-up on open is the guarantee |
| 89 | Upgrade with a pending queue | §10 |

### Backups

| # | Risk | Handled in |
|---|---|---|
| 90 | Restore duplicates history | §11 |
| 91 | Backup contains device keys | §11 |
| 92 | Every device backs up the same data | §11 |

### People

| # | Risk | Handled in |
|---|---|---|
| 93 | Removed laptop keeps history | §2 signed wipe, honest wording |
| 94 | Shared family PC | §12 per OS user |
| 95 | Every device and the phrase lost | §12 onboarding, backups |

### Critical (third pass)

| # | Risk | Handled in |
|---|---|---|
| 96 | Syncing session ratchet state reuses keys | §4 per device-pair sessions, never synced |
| 97 | Two own devices share a group sending key | §4 per-device group keys |
| 98 | A bad entry crash-loops every device | §3 quarantine; fuzzed apply path |
| 99 | Devices use different relays and never meet | §5 synced relay list, merge, warning |

### Cryptography (third pass)

| # | Risk | Handled in |
|---|---|---|
| 100 | Nonce reuse after a restore | §4 random or unique-derived nonces |
| 101 | Same message direct and via sync | §3 dedupe by message id |
| 102 | Recovery phrase leaks | §2 full re-root, friends re-verify |
| 103 | Phrase typed on a compromised device | §2 rare use only |
| 104 | Away during a 24-hour removal | §2 alerts, phrase override |
| 105 | Several read receipts | §4 one receipt |

### Devices (third pass)

| # | Risk | Handled in |
|---|---|---|
| 106 | Too many devices | §2 cap of 5 |
| 107 | Traffic between every pair of devices | §5 mailbox as hub |
| 108 | Two links at once | §2 versioned list |
| 109 | Friend's stale device list | §4 |
| 110 | No camera / not online together | §2 manual code, offline linking |
| 111 | Identical device names | §12 |
| 112 | Missed security notice | §3 `SecurityNotice` |
| 113 | Device offline 90+ days | §6 |

### Data (third pass)

| # | Risk | Handled in |
|---|---|---|
| 114 | Derived data in the fingerprint | §3 originals only |
| 115 | Slow fingerprint over huge history | §3 incremental |
| 116 | Emoji variants | §3 normalisation |
| 117 | Voice notes transcoded | §8 original bytes |
| 118 | Location data differs between copies | §8 stripped file everywhere |
| 119 | Which settings sync | §3 marked per setting |
| 120 | Pin order conflicts | §3 |
| 121 | Nickname vs chosen name | §3 both kept |
| 122 | Disappearing message after expiry | §12 |
| 123 | A release wrote wrong entries | §3 `Correction` |
| 124 | Search index | §12 local only |

### Performance and scope (third pass)

| # | Risk | Handled in |
|---|---|---|
| 125 | First open after months freezes the app | §6 newest first, paged |
| 126 | Many small writes | §10 batching |
| 127 | Short relay retention | §5 measured, warning |
| 128 | TypeScript engine cannot sync | Out of scope |
| 129 | Simulation misses real radios and OS | §14 device beta |

## 14. How this is proven

1. **Model checking** (Stateright) of the core rules: merging, device linking and removal, snapshots and pruning. It
   explores every interleaving, not only imagined ones (targets 45, 97, 108 and the merge rules).
2. **Deterministic simulation.** Several engines in one process on a simulated clock and network, with faults injected:
   - links cut at random points;
   - relays dropping, reordering, replaying and withholding entries;
   - clocks skewed by years;
   - processes killed mid-write;
   - low disk;
   - cloned devices, old-version snapshotters, a thief racing removal, junk floods.

   Millions of seeded runs; any failure replays exactly from its seed. Every run must end with:
   - matching state fingerprints;
   - no lost entry except one covered by a `LostMarker`;
   - live-message latency within its limit while bulk sync runs.
3. **One named test per risk** in §13.
4. **Fuzzing** of entry decoding and the apply path, added to the existing CI fuzz job.
5. **Real-device beta**: vivo and Pixel phones, Windows laptops, poor and metered networks.
6. **External security review** of §2, §4 and §5 before release.

## 15. Build order

Each step ships with its tests and leaves the app working.

1. **Background runner:**
   - shared background policy in Rust;
   - desktop tray, close-to-tray, notifications from Rust, start at login, single instance.
2. **Account and devices:**
   - account root, device certificates and the signed device list;
   - migration of existing users;
   - linking by QR or manual code.
3. **Sync log:**
   - entries, numbering and hash chain;
   - merge rules and pending area;
   - quarantine and fingerprint.
4. **Self-mailbox:**
   - epoch keys and keyed labels;
   - catch-up on open (Invariant 2);
   - "sent means synced" (Invariant 1).
5. **Delivery to every device:**
   - per-device sessions and prekeys;
   - per-device group keys;
   - one receipt per message.
6. **Media:** hash tree, chunked and resumable transfer, nearest source first, priority lanes and the separate bulk
   channel.
7. **Direct sync:** local Wi-Fi and Bluetooth sync, new-device bulk transfer.
8. **Snapshots:** snapshots and pruning, `LostMarker`, `Correction`.
9. **Device removal:** removal and key rotation, wipe, the 90-day rule.
10. **Extras:** quick reply from notifications, scheduled send, desktop automatic backups, usage screen.

## 16. What is built

| Step | State |
|---|---|
| 1. Background runner | Built: desktop tray (close to tray, start at sign-in, one instance); `privcord_domain::background` used by Android for Bluetooth mesh scanning. |
| 2. Account and devices | Built in the engine: device keys, signed device list, migration of existing installs, linking handshake (`devices::link`). No linking screen yet. |
| 3. Sync log | Built: `privcord_crypto::synclog` (entries, merge rules, clone detection, quarantine, fingerprint), simulated and fuzzed. |
| 4. Self-mailbox | Built: `privcord_crypto::selfbox`, `core/sync.rs`. See below. |

What step 4 does today:

- **Recording.** Every change stored in the engine that matters gets an entry: messages sent or received (not open-channel posts), deletes for everyone and for me, reactions, contacts, mutes. The storage port is wrapped, so a new code path cannot forget to sync.
- **Posting.** Entries go to the self-mailbox on the relays the person has configured, before the store-and-forward pass of the same tick.
- **Catching up.** Hellos and answers carry exactly the missing entries; entries are applied the way a restored backup is, and nothing is sent to friends twice.
- **Who syncs.** Today that is installs of one account restored from the recovery phrase: their device lists vouch for each other. A lone install posts nothing.
- **Tested:** phone and laptop never online together, a restart, a stranger on the relay.

Not yet:

- **Read marks and delivery ticks.** Unread state and delivery ticks are not synced.
- **Groups.** Group membership is not synced (group messages are, as rows).
- **File bytes.** Only file metadata is synced; the bytes come with step 6.
- **Delivery waiting for its sync copy.** A message delivered over a direct link in the second before the tick is ahead of its sync copy (step 5).
- **The desktop page in the tray.** It stays alive, because it owns the relay sockets; moving the sockets into Rust is still to do.
- **Relays only, between devices.** Devices exchange entries only through the relays; direct local Wi-Fi and Bluetooth sync is step 7.
