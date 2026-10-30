# Android status

Read this before trusting the Android app.

* **Device-tested by the owner on real hardware: direct 1:1 messaging** (two phones, the single-friend version).
* **NOT device-tested: everything added for contacts and groups** (the multi-contact engine, groups, automatic
  introductions, the new screens, the Room 4 to 5 migration). It compiles, the debug APK builds, and the JVM tests
  below pass, but none of it has run on a phone or emulator.

## What exists

* **Many friends and groups** (`engine/ChatEngine.kt`, `groups/`). One authenticated link per friend (WebRTC, or
  Bluetooth for one friend at a time), one signaling hub for the whole app that opens each sealed blob with the
  pinned key of `blob.from`, per-friend backoff (5 s doubling to 120 s, longest-waiting first), at most 3
  connection attempts at once, a soft cap of 30 open links (`engine/LinkPolicy.kt`), per-link ping/liveness, and
  `relay_blob` forwarding through a mutual friend when signaling cannot be reached. Messages wait in a per-recipient
  outbox. Group messages go to every member over that member's own link; the bubble shows the weakest state and
  "Delivered to 3 of 5". A message for a group or sender we do not know yet is held up to 60 s while we ask for a sync.
* **Groups are a signed event log** (`groups/GroupEvents.kt`, `GroupLog.kt`, `GroupCoordinator.kt`), a byte-compatible
  Kotlin port of `packages/protocol/src/groups`. Anyone in a group can add a friend; the people added are pinned as
  "introduced" and connected to automatically, so nobody has to swap codes (A adds B, B adds C: A and C link).
  Only the creator can remove others or rename; anyone can leave. Removed or left groups stay readable.
* **Screens**: one chat list (friends and groups, last message, unread count, connection dot) with *Add friend*
  and *New group*; one add-friend screen (your invite as QR/copy/share, scan or paste, then an optional skippable
  "check it's really them"); new group (name, choose friends); group details (members with "added by", add
  member, leave; the creator renames and removes); friend details; a chat header with name, one status line and a
  single menu. Dangerous actions (erase everything) are only in Settings > Security; STUN/TURN/relays/Bluetooth/
  connection codes are under *Advanced options* in Settings.
* **Removed**: the Word Code tab and encoder (it only carried a 64-bit fragment of an id and no keys, so it could
  never add a usable friend), the attachment button and the `[Attachment: ...]` text stub with its regex
  rendering, the placeholder group tables, the per-chat "reset pairing", and the cluttered header icons.
* **Room v5** (migration 4 to 5 is non-destructive: messages, queue, contacts are kept; a pinned friend from the
  single-friend version becomes a saved friend and its messages move to that chat). `fallbackToDestructiveMigration`
  is gone: a missing migration now fails loudly instead of silently wiping every message.

* **No cloud backend and no accounts.**
* **Mandatory 12-word recovery identity** (`security/Bip39.kt`, `RecoveryIdentity.kt`). First run shows the
  phrase, makes you re-enter two words, and only then creates the identity (`ui/Onboarding.kt`, no skip).
  "I already have a phrase" restores one. The same phrase gives the **same keys and uid as the TypeScript
  protocol** (checked against vectors, including a non-ASCII passphrase case). The phrase is never stored;
  only the derived private keys are, encrypted under a non-exportable Keystore AES key.
* **Contact cards** `DUOID1:` (`ContactCard.kt`) and an Add-friend dialog (`ui/ContactDialog.kt`): copy your card,
  paste your friend's, compare the safety number, pin. The pinned record stores the friend's ECDH key so
  blobs can be sealed to them. No QR scanner yet (copy/paste only).
* **Sealed blobs** (`Seal.kt`): ECDH P-256 + HKDF + AES-256-GCM, ECDSA-signed, exactly the desktop format, plus
  a byte-exact `CanonicalJson` (signatures cover it) and `mailboxFor`.
* **Signaling, replaceable** (`signaling/`): an interface, a `SignalingHub` that runs several at once,
  `RelayClient` (OkHttp WebSocket, the self-hosted relay protocol) and `NostrTransport` (BIP-340 Schnorr on
  secp256k1, a fresh random key per event, kinds 21733 / 31733, `t` / `d` / `expiration` tags).
* **Automatic reconnect for a paired friend** (`ChatEngine`): sealed `ready` / `offer` / `answer` exchange,
  the lower uid is the initiator, backoff 5 s doubling to 120 s, retry when Android reports a new network
  (`ConnectivityManager` callback). Manual codes still work and take priority while a manual attempt is open.
* **Optional store-and-forward** (off by default): sealed `msg` + `ack`, held by the relay, 7 day TTL. No
  forward secrecy for these messages (sealed box), same as desktop.
* **Liveness**: ping every 4 s while authenticated, pong echoes `at`, any inbound frame counts, 14 s of silence
  closes the channel as lost and the normal reconnect runs (`p2p/Liveness.kt`).
* **Network settings UI** (Settings > Network): Nostr relays, your own relay, STUN, TURN, always-relay,
  store-and-forward, Bluetooth switch.
* **Bluetooth LE** (wired, never run on a radio; details and the on-device checklist in
  [BLE_TRANSPORT.md](BLE_TRANSPORT.md) sections 10 and 12): `SecureBleLink` adds the same forward-secret,
  pinned-contact-authenticated encryption as desktop on top of `BleTransport` (central and peripheral roles);
  `PeerSession` runs the usual hello/auth handshake over it; `ChatEngine` makes automatic attempts with backoff
  and a manual one; Settings has a status row, a permission rationale, the runtime request (scan/advertise/connect on
  API 31+, location on 30 and below) with denial handling, and a *Connect over Bluetooth* button. The path
  shows as *Bluetooth, no internet*.
* **Real path reporting** from `PeerConnection.getStats` (host / srflx / prflx / relay rules), shown in
  Settings and the chat header. Never inferred from configuration.

## Verification (this sandbox)

* SDK 35 at `/tmp/claude-0/asdk/sdk`, Gradle 8.14.3 (`/opt/gradle/bin/gradle`), `ANDROID_HOME` set. Commands:
  `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `:app:assembleDebug` all succeed.
* **97 JVM unit tests pass** (forced rerun, 0 failed, 0 skipped) across 13 suites. The vector-driven ones compare Kotlin to
  `docs/android-vectors.json`, which `packages/protocol/scripts/gen-android-vectors.ts` produces from the
  TypeScript protocol (`npx vite-node scripts/gen-android-vectors.ts` in `packages/protocol`):
  * recovery: 4 phrases (one with the BIP-39 "TREZOR" passphrase, one with a non-ASCII passphrase): seed, both
    HKDF materials, both private scalars, both public points, uid, and that TypeScript's identity proof
    verifies against Kotlin's keys; entropy to mnemonic (4); invalid phrases (3)
  * canonical JSON: 8 cases incl. control characters, U+2028, emoji and a lone surrogate
  * contact cards decode to the TypeScript uid and re-encode identically; a forged card is rejected
  * sealed blobs made by TypeScript open in Kotlin in both directions; wrong recipient, wrong sender, wrong
    signer and a flipped ciphertext are all refused; mailbox hashes match
  * `NetworkConfig` parsing matches `parseNetworkConfig` on 7 inputs
  * BIP-340: the official vector 0, plus public key, reproducible signature, and event id all equal to
    `@noble/curves`; a Kotlin-built event is identical to the TypeScript one; TypeScript events verify
  * liveness frames: 8 accept/reject cases from `parsePeerFrame`; 14 s dead-link rule; backoff schedule
  * `SecureChannelTest` (13): the Bluetooth link encryption against TypeScript frames in both directions (Kotlin
    decrypts TypeScript's frames and produces the identical ciphertext; TypeScript accepts Kotlin's hello and
    decrypts its frames, in `packages/protocol/test/androidInterop.test.ts`), plus tamper, replay, wrong signer,
    forward secrecy and misuse
  * `SecureBleLinkTest` (10): secure link with an in-memory radio, status table, permissions list, backoff
* **Groups** (`docs/group-vectors.json`, generated by `packages/protocol/scripts/gen-group-vectors.ts`):
  * `GroupVectorsTest` (7): TypeScript-signed events (create, add with and without a card name, remove, rename, a
    group name with quotes, a control character and emoji) get the same ids from Kotlin and verify; replaying the
    TypeScript traces gives the same status, effectiveness, roster, causal order and heads at every step, including
    concurrent add/remove ("remove wins") under 12 arrival orders, buffering of events that arrive before their
    dependencies, and the rejections (outsider, forged signature, wrong card, member removing the admin, tampered
    body, no deps, wrong group); frame parsing agrees with `parseGroupFrame` on 17 cases.
  * `GroupSimulationTest` (7): Kotlin ports of the TypeScript simulations: A adds B and B adds C and A and C link
    with no code sharing, a member added while another is offline, spam and history pulls by non-members, removal,
    a **25-member chain** (each added by their neighbour: identical rosters, full mesh, 600 links) and a
    12-member growth run with members dropping offline.
  * `LinkPolicyTest` (9): initiator rule, 3 concurrent attempts, per-friend backoff, 30-link soft cap, the 60 s
    hold buffer, relay de-duplication.
  * Kotlin-signed events are written to `app/build/interop/kotlin-group-events.json`;
    `packages/protocol/test/groupInterop.test.ts` loads them into the TypeScript `GroupLog` and every one is
    accepted and effective (skipped when the file is absent).
* **Real relay interop** (`RelayInteropTest`, 5 tests) starts `node relay/index.js` and a small NIP-01 relay
  (`src/test/resources/nostr-relay.mjs`) and runs two Kotlin clients through them: a sealed offer is
  delivered, store-and-forward holds a sealed message for an offline friend and replays it, an instance with
  store-and-forward disabled refuses `msg` but still relays `sig`, Nostr delivers a sealed blob. The test
  skips with a message if `node` or `relay/node_modules` is missing.
* **Kotlin to TypeScript**: the same test class writes `app/build/interop/kotlin-vectors.json`;
  `packages/protocol/test/androidInterop.test.ts` verifies the card, the sealed blob and the Nostr event with the
  TypeScript implementation (skipped when the file is absent).

## What is NOT done or NOT verified

* **Groups, introductions and every new screen have never run on a device or emulator.** The group core is proven
  against TypeScript, but the engine that wires it to real links (`ChatEngine`) cannot run on the JVM (it needs
  Android keystore, WebRTC and Bluetooth), so it has **no automated test**. Things nobody has seen work: a real
  introduction over WebRTC, `relay_blob` forwarding, the 60 s hold buffer in practice, Room 4 to 5 on a real
  database (the SQL was checked in SQLite, Room itself did not run it), the notification permission prompt, the QR
  scanner on the add-friend screen, back navigation and process death on the new routes.
* **Many members**: a full mesh means N-1 links per phone. 25 members converge in simulation, but a phone running
  25 WebRTC links has not been tried, and the soft cap is 30. Connection attempts are 3 at a time, so a big group
  with many offline members takes a while to finish connecting.
* **Friends from the single-friend version** have no identity proof stored; it is learned the first time they
  connect after the update. Until then they cannot be added to a group (the app says so).
* **Bluetooth** is wired per friend but only one friend at a time may use it, and it has still never met a real
  radio (see BLE_TRANSPORT.md section 12). Android runs it only while the app process is alive.
* **Background reconnect**: everything runs in the ViewModel scope while the app process is alive; there is no push.
* **Cleartext**: Android blocks plain `ws://`; relays must be `wss://`. The JVM tests use `ws://`.
* **The recovery phrase is shown on screen with no `FLAG_SECURE`.** Not added yet.
* **Replacing the identity from Settings** is not offered (only on first run); use *Erase everything*, then restore.
* **Group messages have no history for new members and no read receipts**; removal does not erase what a removed
  member already received. A malicious introducer could introduce an impostor, which is why introduced friends are
  labelled and can be checked (see GROUPS.md section 6).
* **Large message lists**: the newest 4000 messages are loaded into memory; older ones stay on disk.
* **P-256 and secp256k1 math is not constant time** (BigInteger), as before.
* **Not tested across two real networks** and not against public Nostr relays.
