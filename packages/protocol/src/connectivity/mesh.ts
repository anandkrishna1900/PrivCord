import { sha256 } from '../e2ee/primitives';

/**
 * PrivCord Decentralized BLE Multi-hop Mesh Protocol Specification
 *
 * Mesh Packet Format:
 * - packetId: 16-byte random hex string to deduplicate across the mesh
 * - originUid: Author/initiator UID
 * - destUid: Final recipient UID (or '*' for broadcast / discovery)
 * - ttl: Time To Live (hops allowed remaining, e.g. 5)
 * - maxHops: Initial hop limit
 * - timestamp: Unix ms when originated
 * - payload: Encrypted payload (SealedBlob or GroupEncryptedMessage)
 *
 * Intermediate nodes forward ciphertext without decrypting or possessing message keys.
 */

export interface MeshPacket {
  v: 1;
  kind: 'mesh_pkt';
  packetId: string;
  originUid: string;
  destUid: string;
  ttl: number;
  maxHops: number;
  timestamp: number;
  payload: string; // Base64 or JSON-stringified ciphertext
}

export interface MeshDeliveryAck {
  v: 1;
  kind: 'mesh_ack';
  packetId: string;
  ackedByUid: string;
  timestamp: number;
}

export class MeshRouter {
  private seenPackets = new Set<string>();
  private packetCache = new Map<string, { packet: MeshPacket; expiresAt: number }>();
  private readonly maxCacheSize: number;
  private readonly defaultTtl: number;

  constructor(options?: { maxCacheSize?: number; defaultTtl?: number }) {
    this.maxCacheSize = options?.maxCacheSize ?? 1000;
    this.defaultTtl = options?.defaultTtl ?? 5;
  }

  /**
   * Determine whether a packet should be accepted and forwarded.
   * Returns:
   *  - 'CONSUME' if addressed to our own UID
   *  - 'FORWARD' if should be relayed to peer neighbors
   *  - 'DROP' if seen already, loop detected, or TTL expired
   */
  processPacket(
    packet: MeshPacket,
    ownUid: string,
    nowMs: number = Date.now(),
  ): 'CONSUME' | 'FORWARD' | 'DROP' {
    if (packet.v !== 1 || packet.kind !== 'mesh_pkt') return 'DROP';
    if (packet.ttl <= 0) return 'DROP';
    if (this.seenPackets.has(packet.packetId)) return 'DROP';

    // Anti-replay / loop prevention
    this.seenPackets.add(packet.packetId);
    if (this.seenPackets.size > this.maxCacheSize * 2) {
      const iter = this.seenPackets.values();
      for (let i = 0; i < 500; i++) {
        const next = iter.next();
        if (next.done) break;
        this.seenPackets.delete(next.value);
      }
    }

    // Packet validity check
    if (nowMs - packet.timestamp > 24 * 3600 * 1000) {
      return 'DROP'; // Expired (> 24 hours)
    }

    if (packet.destUid === ownUid || packet.destUid === '*') {
      // Store packet if broadcast or for us
      return 'CONSUME';
    }

    return 'FORWARD';
  }

  /**
   * Decrement TTL before forwarding. Returns cloned packet or null if TTL exhausted.
   */
  nextHopPacket(packet: MeshPacket): MeshPacket | null {
    if (packet.ttl <= 1) return null;
    return {
      ...packet,
      ttl: packet.ttl - 1,
    };
  }

  /**
   * Store for store-carry-forward when no direct route to destination is currently connected.
   */
  storePacket(packet: MeshPacket, ttlMs: number = 3600 * 1000): void {
    if (this.packetCache.size >= this.maxCacheSize) {
      // Evict oldest
      const firstKey = this.packetCache.keys().next().value;
      if (firstKey) this.packetCache.delete(firstKey);
    }
    this.packetCache.set(packet.packetId, {
      packet,
      expiresAt: Date.now() + ttlMs,
    });
  }

  getPacketsForPeer(peerUid: string, nowMs: number = Date.now()): MeshPacket[] {
    const matching: MeshPacket[] = [];
    for (const [id, entry] of this.packetCache.entries()) {
      if (entry.expiresAt < nowMs) {
        this.packetCache.delete(id);
        continue;
      }
      if (entry.packet.destUid === peerUid || entry.packet.destUid === '*') {
        matching.push(entry.packet);
      }
    }
    return matching;
  }
}

