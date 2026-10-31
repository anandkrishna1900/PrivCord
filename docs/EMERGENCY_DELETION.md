# DuoChat — Emergency Deletion (Kill Switch)

**Version**: 1.0  
**Date**: October 2026

---

## 1. Overview & Philosophy

DuoChat provides two emergency deletion mechanisms:
1. **App-Wide Emergency Kill Switch ("NUKE DUOCHAT")**: Irreversibly erases all local application data, networking sessions, databases, and keys on this device, resetting DuoChat to its first-time onboarding screen.
2. **Individual Conversation Kill Switch ("Clear Everything")**: Erases local messages and assets for a selected conversation, with an option to also erase local session cryptographic state.

### Absolute Honesty Principle:
DuoChat displays a **truthful execution report**. If an individual step cannot be completed (e.g., file lock or OS permission denial), it is explicitly reported as failed or partial. The UI never falsely claims that "everything was deleted" if any step failed.

---

## 2. What App-Wide "NUKE DUOCHAT" Erases

When triggered from `Settings → Security → Emergency Actions`:

1. **Active Networking**:
   - WebRTC peer connections closed (`pc.close()`).
   - DataChannels terminated.
   - Active signaling streams / subscriptions cancelled.
   - In-flight network tasks aborted.
2. **Local Messaging & History**:
   - Every local conversation record deleted.
   - All messages, message indexes, delivery receipts, and read metadata removed from SQLite / IndexedDB / Room.
   - Drafts and search history cleared.
3. **Contacts, Groups & Trust Records**:
   - Contact list, public keys, trust records, safety numbers erased.
   - Group metadata and group encryption session keys wiped.
4. **Files & Attachments**:
   - Downloaded media, images, video, audio attachments deleted from app storage.
   - Temporary file-transfer chunks and pending transfer queues erased.
5. **Queues & Caches**:
   - Outbox queued unsent messages removed.
   - Decrypted ephemeral chunks purged from memory.
6. **Cryptographic State**:
   - Local device identity private keys wiped from secure keystores.
   - Double Ratchet session states, chain keys, and skipped message keys wiped.
7. **Application Reset**:
   - Local settings deleted.
   - Application logs cleared.
   - App returned to first-run / onboarding state.

---

## 3. Individual Conversation Kill Switch

Accessed via `Conversation Header → Security → Clear Everything`:

### Option A — CLEAR LOCAL CHAT
- Deletes all local messages, attachments, previews, and drafts for that specific conversation.
- Retains global identity keys and existing cryptographic session state for seamless next messages.

### Option B — DELETE CHAT AND LOCAL SESSION STATE
- Deletes all local messages and attachments.
- Additionally wipes the conversation's Double Ratchet session state and cached keys on this device.
- Subsequent communications require a fresh X3DH cryptographic handshake.

---

## 4. Truthful Limitations & Forensic Realities

- **Remote Data**: Local deletion affects **only** this local device. It cannot erase messages from the peer's device or physical backups.
- **Flash Storage & Wear Leveling**: Modern NAND flash controllers employ wear leveling and over-provisioning. Overwriting files does not guarantee that raw flash cells are physically wiped; full disk encryption (FDE) at the OS level is required for physical erasure guarantees.
- **OS Caches & Screenshots**: System clipboard history, OS notification logs, or screenshots taken by the user/system outside the app sandbox cannot be deleted by DuoChat.


## Panic wipe (one gesture, off by default)

Settings > Security > **Panic wipe**. When on, **Ctrl+Shift+Backspace pressed three times within two seconds** (desktop) or **three quick taps on the "DuoChat" title on the home screen** (Android) erases everything on the device straight away, with no confirmation, and returns to the start screen. It runs the same erase as "Erase everything". It is off by default because a mistaken gesture cannot be undone: only your 12 recovery words bring your identity back, and chats are not in that phrase (use an encrypted backup for those). It does not affect other people's devices.
