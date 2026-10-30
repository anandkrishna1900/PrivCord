# Encrypted Chunked File Sharing

## Specification
1. **Transfer Initialization**:
   - The sender generates a random 16-byte `transferId` and 32-byte AES-256 transfer key.
   - Computes whole-file SHA-256 digest.
   - Emits `FileMetadata`:
     ```json
     {
       "transferId": "...",
       "name": "image.png",
       "mimeType": "image/png",
       "size": 1048576,
       "sha256": "...",
       "totalChunks": 32,
       "chunkSize": 32768,
       "keyB64Url": "..."
     }
     ```

2. **Chunk Transmission**:
   - Chunks are encrypted individually with unique 12-byte IVs.
   - Associated data: `file|<transferId>|<chunkIndex>`.
   - Transmitted via WebRTC DataChannel or BLE / BLE Mesh.

3. **Reassembly & Verification**:
   - Receiver collects all chunks into buffer.
   - Reassembles in sequential chunk order.
   - Computes SHA-256 digest and verifies match with metadata.
   - If hash mismatch occurs, transfer is discarded as tampered.
