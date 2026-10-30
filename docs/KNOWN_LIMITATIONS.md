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
- **Full mesh.** Every member connects to every other member, so a group of N means N-1 links per
  device. The logic is simulated to 25 members and tested with 6 real browsers; phones may struggle
  well before 30. The apps cap simultaneous links at 30.
- **Introductions are trust.** Anyone who is added to a group by a member you already trust becomes a
  contact (labelled "Introduced by NAME"). A malicious or compromised member could introduce an
  impostor. Use Verify (the safety numbers) for people who matter.
- **Removal is forward-looking.** A removed member keeps what they already received, and nothing can
  delete it.
- **New members get no history.** They see messages sent after they joined.
- **Admin is the creator.** Only the creator can remove others or rename the group.
- **Large groups and offline members.** Messages for a member you cannot reach yet are queued and sent
  when the link opens.

## 5. Not available
- No file or photo attachments.
- No push notifications (there is no server to send them).
- No multi-hop Bluetooth mesh.
