# DuoChat — Known Limitations & Threat Model

**Version**: 1.0  
**Date**: October 2026

---

## 1. Remote Participant Erasure
Local kill switch activation operates strictly within the local device boundary:
- **No Remote Erasure**: Activating "NUKE DUOCHAT" or "Clear Everything" deletes data on the current device only. It cannot and does not erase copies of messages, images, or media already delivered to the other participant's device.
- **Remote Revocation**: Any future remote deletion mechanism would require signed requests that depend on network connectivity and cannot guarantee deletion on offline, compromised, or modified clients.

---

## 2. Storage & Hardware Realities
- **Wear Leveling on Solid State / Flash Memory**: Flash memory (eMMC, UFS, NVMe SSDs) utilizes controller-level wear leveling. Cryptographic deletion (deleting the key required to decrypt the ciphertext) is the only reliable erasure method on modern solid-state drives.
- **Operating System Backups**: If the user has OS-level cloud backups enabled (e.g., full device images), external backups created prior to deletion may retain historical states.
- **Screenshots & Screen Recorders**: Operating system level screen capture, third-party screen recorders, or hardware captures cannot be detected or deleted by DuoChat.
- **OS Keyboard / IME Caches**: Some third-party Android keyboards log predictive text outside the application's sandbox. Users in high-security environments should use open-source keyboards with network permissions disabled.

---

## 3. Network & Transport Constraints
- **Direct P2P NAT Traversal**: In symmetrical NAT environments where STUN cannot resolve a direct route, WebRTC falls back to encrypted TURN relays. While traffic is end-to-end encrypted, metadata (IP address, packet timing) is visible to the relay operator.

---

## 4. Groups
- **At most 10 members** (including the creator), enforced by every device identically. A group of N
  means N-1 links per device (a full mesh), so 10 means 9. The limit is tested in protocol simulation
  and in the browser suite; real-phone behaviour at 10 is not tested.
- **Introductions are trust.** Someone added by a member you trust becomes a contact you can message
  directly (labelled "Introduced by NAME"). A malicious or compromised member could introduce an
  impostor; use the safety numbers for people who matter.
- **Group-only opt-out.** With "Stay group-only with people I meet in groups" on (Settings > Security),
  or if the other person has it on, you cannot start a direct chat with someone you only know through a
  group. You still exchange group messages, replies and files, and you can pair manually by swapping
  invites. It does not hide you from the group: members still learn your identity key and connect to
  you to deliver group messages, so a direct (non-relayed) link exposes your IP address to them. A
  modified client could ignore the setting; it is a courtesy between honest clients, not a guarantee.
- **Removal is forward-looking.** A removed member keeps what they already received, and nothing can
  delete it.
- **New members get no history.** They see messages sent after they joined.
- **Admin is the creator.** Only the creator can remove others or rename the group.
- **Large groups and offline members.** Messages for a member you cannot reach yet are queued and sent
  when the link opens.

## 5. Six-word invites
- The six words are a **meeting point**, not the identity itself (an identity card is far too big for six
  words): 66 random bits from which both phones derive a relay mailbox and a key. The person showing the
  words publishes their card there, encrypted; the other types the words, fetches it and answers with their
  own card; the first person then **confirms who answered** with the safety numbers.
- They need a connection service (a Nostr relay or your own relay) and the person showing the words must
  keep the app open: the words stop working after 15 minutes or when the app closes. The QR code and the
  full invite text (under "Full invite text") work with no service at all.
- Anyone who learns the words while they are valid can read the card (public information) and can answer
  it, which is why the answer is always confirmed by a person. A relay sees only a hash and encrypted bytes;
  guessing 66 bits offline is not practical (each guess costs a 150,000-round key derivation).

## 6. App lock
- **Android** uses the system prompt (fingerprint, face or screen lock) every time the app opens and after
  30 seconds out of sight. **Windows** uses a Windows Hello passkey (WebAuthn, user verification required,
  the signature is checked against the stored public key) when the app opens, after 5 minutes out of
  sight, and on "Lock now". Turning it off needs the same proof.
- It keeps other people at an unlocked device out. It is **not** protection against someone who copies the
  files off the disk (they are encrypted with a separate key) and it does not stop the app from receiving
  messages while locked: notifications can still show message text unless you turn previews off.
- Not tested on a real Windows Hello prompt or a real Android biometric prompt; the desktop flow is tested
  against a virtual authenticator and the Android decision rules by unit tests.
- Video and image previews are decoded by the system's media components. Other file types are never
  opened by PrivCord, only saved.

## 7. Not available
- Files are limited to **8 MB**, go **device to device** (never through a server or the offline
  relay) and need a WebRTC link, so they are not sent over Bluetooth. A file for someone offline waits
  on your device and is sent when they reconnect. In a group a file is sent separately to every member
  (up to 9 copies), so it uses your upload each time. Received files are saved encrypted on the
  device; "Save" writes an ordinary file. Only PNG, JPEG, GIF and WebP images and MP4, WebM, QuickTime and Ogg videos get a preview, never SVG, and no other file type is opened.
  File saving from the packaged desktop app has only been exercised in the browser suite.
- No push notifications (there is no server to send them).
- The Bluetooth mesh exists on Android only and has never run on real radios; Windows cannot join it ([details](CHANNELS_AND_MESH.md)).

## Connecting across cities or mobile networks (e.g. Kerala to Kolkata)

Distance does not matter, the networks do. A direct link needs both phones to find a path to each other:

- Most Indian mobile data (Jio, Airtel, Vi) sits behind carrier-grade NAT. STUN alone often cannot punch through two of these at once. A **TURN relay** is the fix.
- The app now shows a plain-language banner in the chat saying which case you are in, with a one-tap **Deliver via relays** button (store-and-forward) so messages still arrive while a direct link is impossible.
- To get live links across any two networks, run a relay (TURN) server. `docs/turn-server/` has a ready docker-compose and config for a small VPS, and a script that prints one `PRIVCORD-TURN1:` line. Paste that line into Settings > Connection on every device (desktop and Android) and the three relay fields fill in. The relay only carries encrypted traffic, but the line contains its password, so share it only with people you want to let use it. The kit and the line format are tested; coturn itself has not been run against it from the development environment.
- Not verified on real carrier networks from the development environment; the diagnosis logic is unit-tested, the field behaviour is not.
