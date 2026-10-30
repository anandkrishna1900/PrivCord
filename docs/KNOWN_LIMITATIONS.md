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

## 5. Not available
- Files are limited to **8 MB**, go **device to device** (never through a server or the offline
  relay) and need a WebRTC link, so they are not sent over Bluetooth. A file for someone offline waits
  on your device and is sent when they reconnect. In a group a file is sent separately to every member
  (up to 9 copies), so it uses your upload each time. Received files are saved encrypted on the
  device; "Save" writes an ordinary file. Only PNG, JPEG, GIF and WebP are previewed, never SVG.
  File saving from the packaged desktop app has only been exercised in the browser suite.
- No push notifications (there is no server to send them).
- No multi-hop Bluetooth mesh.
