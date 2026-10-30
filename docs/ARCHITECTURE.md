# PrivCord / DuoChat — Complete Architecture Documentation

## Overview
PrivCord (DuoChat) is an end-to-end encrypted, zero-account, decentralized messaging application supporting Android and Desktop. It operates without centralized accounts, phone numbers, or cloud databases.

## 1. Identity & Cryptography
- **BIP-39**: 12-word mnemonic seed derivation.
- **NIST P-256 (secp256r1)**:
  - ECDSA: Authenticated signing for contact cards, ephemeral handshakes, and sealed mailboxes.
  - ECDH: Point-to-point key agreement and ephemeral link forward-secrecy.
- **HKDF-SHA-256**: Key derivation for ratchets, link encryption, and storage encryption.
- **AES-256-GCM**: Frame and message content authenticated encryption with associated data (AAD).

## 2. Multi-Contact Architecture (Phase 1)
- Multi-peer storage schema (Room Database v4 / SQLite).
- Individual conversation threads isolated by `conversationId`.
- Independent connection and signaling sessions per contact.
- Contact cards with cryptographically bound signatures and safety numbers.

## 3. Group Messaging Architecture (Phase 2)
- **Epoch-Based Group Sender Keys (`GroupSessionManager`)**:
  - Each group contains distinct epochs.
  - Forward-secrecy & break-in recovery: Keys rotate on epoch change.
  - Evicted members cannot decrypt future epoch messages.
  - Ephemeral epoch keys distributed via pairwise sealed envelopes.

## 4. Bluetooth Multi-Hop Mesh (Phase 3)
- **Mesh Packet Protocol (`MeshRouter` / `AndroidMeshRouter`)**:
  - Format: `{ packetId, originUid, destUid, ttl, maxHops, timestamp, payload }`.
  - Loop prevention: 16-byte random packet IDs deduplicated across sliding cache.
  - Zero plaintext leakage: Intermediate relay nodes forward ciphertext envelopes without message keys.
  - Store-Carry-Forward: Nodes store unexpired packets for offline neighbors.

## 5. Automatic Transport Selection (Phase 4)
- **Fallback Strategy**:
  1. Direct Bluetooth Low Energy link.
  2. BLE Mesh Multi-hop route.
  3. Internet WebRTC Direct DataChannel.
  4. Encrypted Nostr / Self-hosted Relay queue.
  5. Local encrypted outbox queue.
- UI status reflects actual transmission state: `QUEUED`, `SENT`, `DELIVERED`, `READ`, `FAILED`.

## 6. Encrypted File Sharing (Phase 5)
- **Chunked File Transfer (`FileTransferManager`)**:
  - Fixed-size chunking (16KB – 64KB).
  - Per-transfer unique AES-256-GCM encryption key.
  - SHA-256 cryptographic verification of reassembled payload.
  - Progress tracking, pause, resume, and incomplete transfer cleanup.

## 7. Android Background Receiving (Phase 6)
- Persistent `DuoBackgroundService` with `connectedDevice` foreground service type.
- Network callback monitoring and automatic session recovery.
- Battery optimization guidelines in settings.

## 8. Emergency Deletion (Phase 9)
- Rapid kill-switch mechanism:
  - Destroys active WebRTC peer connections and BLE links.
  - Purges local Room SQLite database tables (`messages`, `outbox`, `contacts`, `groups`, `file_transfers`).
  - Purges Android Keystore / local encrypted private key material.

