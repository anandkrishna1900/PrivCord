import { validateBlob, type SealedBlob } from '../connectivity/seal';

/*
 * Bluetooth mesh relaying (multi-hop). Phones within radio range link up with whoever else is nearby, and every
 * phone passes new messages on to its other neighbours, so a message can cross several phones to reach someone
 * out of range of the sender.
 *
 * The mesh carries SealedBlobs only: direct messages are already end-to-end encrypted to their recipient and
 * signed, channel messages are signed. A relaying phone never needs keys and cannot alter a message
 * (the signature would break). It does see the blob's `from`/`to` labels and the timing, which is stated in
 * docs/KNOWN_LIMITATIONS.md.
 *
 * This file is the radio-independent logic: validate, drop repeats, count hops, flood to neighbours, carry
 * messages for neighbours that show up later, and refuse spammers. It is exercised by simulation.
 */

export const MESH_MAX_TTL = 7;
export const MESH_MAX_PACKET_BYTES = 8 * 1024;
export const MESH_CARRY_MS = 30 * 60_000;

export interface MeshPacket {
  v: 1;
  kind: 'mesh';
  /** Identifies the message across the whole mesh (a prefix of the blob's signature). */
  id: string;
  /** Hops left. */
  ttl: number;
  blob: SealedBlob;
}

export function packetId(blob: SealedBlob): string {
  return blob.sig.slice(0, 24);
}

export function makeMeshPacket(blob: SealedBlob, ttl = MESH_MAX_TTL): MeshPacket {
  return { v: 1, kind: 'mesh', id: packetId(blob), ttl: Math.min(Math.max(1, Math.floor(ttl)), MESH_MAX_TTL), blob };
}

export function parseMeshPacket(value: unknown): MeshPacket | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== 1 || p.kind !== 'mesh' || typeof p.id !== 'string' || typeof p.ttl !== 'number') return null;
  if (!Number.isInteger(p.ttl) || p.ttl < 1) return null;
  if (!validateBlob(p.blob)) return null;
  if (p.id !== packetId(p.blob)) return null;
  if (JSON.stringify(value).length > MESH_MAX_PACKET_BYTES) return null;
  // A neighbour cannot make a message travel further than the mesh allows, whatever it writes in `ttl`.
  return { v: 1, kind: 'mesh', id: p.id, ttl: Math.min(p.ttl, MESH_MAX_TTL), blob: p.blob };
}

export interface MeshOptions {
  /** How many different messages one sender may put into the mesh per minute before we stop passing them on. */
  perSenderPerMinute?: number;
  seenCapacity?: number;
  carryMs?: number;
  carryCapacity?: number;
}

export interface Outgoing {
  link: string;
  packet: MeshPacket;
}

export interface HandleResult {
  /** A blob this phone has not seen before: the caller tries to open it (direct message? joined channel?). */
  accepted: SealedBlob | null;
  forward: Outgoing[];
}

interface Carried {
  packet: MeshPacket;
  storedAt: number;
  sentTo: Set<string>;
}

/** One phone's view of the mesh. Link ids are whatever the radio layer uses to name a neighbour. */
export class MeshNode {
  private links = new Set<string>();
  private seen = new Map<string, number>();
  private carried = new Map<string, Carried>();
  private senderWindow = new Map<string, number[]>();
  private readonly o: Required<MeshOptions>;

  constructor(options: MeshOptions = {}) {
    this.o = {
      perSenderPerMinute: options.perSenderPerMinute ?? 30,
      seenCapacity: options.seenCapacity ?? 4000,
      carryMs: options.carryMs ?? MESH_CARRY_MS,
      carryCapacity: options.carryCapacity ?? 300,
    };
  }

  get neighbours(): string[] {
    return [...this.links];
  }

  /** A message we wrote: send it to every neighbour and keep it for ones that arrive later. */
  inject(blob: SealedBlob, now: number): Outgoing[] {
    const packet = makeMeshPacket(blob);
    this.remember(packet.id, now);
    const entry = this.carry(packet, now);
    const out = [...this.links].map((link) => ({ link, packet }));
    for (const o of out) entry?.sentTo.add(o.link);
    return out;
  }

  /** A packet from a neighbour. */
  handle(raw: unknown, from: string, now: number): HandleResult {
    const packet = parseMeshPacket(raw);
    if (!packet || this.seen.has(packet.id)) return { accepted: null, forward: [] };
    this.remember(packet.id, now);
    if (!this.allowSender(packet.blob.from, now)) return { accepted: null, forward: [] };
    const next: MeshPacket | null = packet.ttl > 1 ? { ...packet, ttl: packet.ttl - 1 } : null;
    const forward: Outgoing[] = [];
    if (next) {
      const entry = this.carry(next, now);
      entry?.sentTo.add(from);
      for (const link of this.links) {
        if (link === from) continue;
        forward.push({ link, packet: next });
        entry?.sentTo.add(link);
      }
    }
    return { accepted: packet.blob, forward };
  }

  /** A new neighbour: hand it everything we are carrying that it has not been given. */
  linkUp(link: string, now: number): Outgoing[] {
    this.links.add(link);
    this.expire(now);
    const out: Outgoing[] = [];
    for (const c of this.carried.values()) {
      if (c.sentTo.has(link)) continue;
      c.sentTo.add(link);
      out.push({ link, packet: c.packet });
    }
    return out;
  }

  linkDown(link: string): void {
    this.links.delete(link);
    // A link that drops may have dropped a packet in flight. Forget what we "sent" over it so the next link-up
    // hands everything over again; the other phone ignores copies it already has.
    for (const c of this.carried.values()) c.sentTo.delete(link);
  }

  /* ---- internals ---- */

  private remember(id: string, now: number): void {
    this.seen.set(id, now);
    if (this.seen.size > this.o.seenCapacity) this.seen.delete(this.seen.keys().next().value as string);
  }

  private carry(packet: MeshPacket, now: number): Carried | null {
    if (packet.ttl < 1) return null;
    this.expire(now);
    const entry: Carried = { packet, storedAt: now, sentTo: new Set() };
    this.carried.set(packet.id, entry);
    if (this.carried.size > this.o.carryCapacity) this.carried.delete(this.carried.keys().next().value as string);
    return entry;
  }

  private expire(now: number): void {
    for (const [id, c] of this.carried) if (now - c.storedAt > this.o.carryMs) this.carried.delete(id);
  }

  /** At most `perSenderPerMinute` new messages from one sender are passed on; the rest are ignored. */
  private allowSender(from: string, now: number): boolean {
    const recent = (this.senderWindow.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.o.perSenderPerMinute) {
      this.senderWindow.set(from, recent);
      return false;
    }
    recent.push(now);
    this.senderWindow.set(from, recent);
    if (this.senderWindow.size > 2000) this.senderWindow.delete(this.senderWindow.keys().next().value as string);
    return true;
  }
}
