# Group Messaging Specification

## Epoch-Based Sender Key Protocol
PrivCord groups utilize epoch-based forward-secret group encryption:

1. **Epoch Creation**:
   - An administrator initiates or rotates the group epoch.
   - An epoch secret is generated via 32-byte cryptographically secure random bytes.
   - The epoch secret is sealed individually to each active member using pairwise X3DH / sealed blobs (`duochat-seal-v1`).

2. **Group Encryption**:
   - Sender constructs message payload.
   - Encrypts via AES-256-GCM using the current epoch key.
   - Authenticated data binds `group|<groupId>|<epoch>|<senderUid>|<seq>`.

3. **Member Eviction**:
   - When a member is removed, the epoch is incremented immediately ($e \to e + 1$).
   - A new epoch secret is generated and delivered only to remaining active members.
   - The removed member cannot decrypt epoch $e + 1$ or any future epochs.
