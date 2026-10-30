import type { ContactCard } from '../connectivity/contactCard';
import {
  cardIsValid,
  eventIdMatches,
  isGroupEventShape,
  signatureValid,
  type GroupEvent,
} from './events';

export interface GroupMemberInfo {
  uid: string;
  card: ContactCard;
  role: 'admin' | 'member';
  /** Who introduced this member to the group. Shown to users as "added by". */
  addedBy: string;
}

export interface GroupState {
  groupId: string;
  name: string;
  createdBy: string;
  members: Map<string, GroupMemberInfo>;
}

export type AddStatus = 'applied' | 'buffered' | 'duplicate' | 'invalid';

export const MAX_EVENTS_PER_GROUP = 5000;
export const MAX_PENDING_EVENTS = 300;

const keyId = (jwk: JsonWebKey) => `${jwk.x}.${jwk.y}`;

/**
 * The replicated log of one group. Events form a DAG (each lists the heads its author had seen),
 * and the roster is a deterministic fold of that DAG, so every replica holding the same events
 * computes the same roster regardless of arrival order or clock skew.
 *
 * Conflicts: among concurrent events, removals are applied first ("remove wins"), then the rest by
 * event id. An event that is not permitted at its position (author not a member, not an admin for a
 * removal, bad signature, bad card) has no effect.
 */
export class GroupLog {
  private events = new Map<string, GroupEvent>();
  private pending = new Map<string, GroupEvent>();
  private sigCache = new Map<string, boolean>();
  private current: GroupState | null = null;
  private validIds = new Set<string>();

  constructor(readonly groupId: string) {}

  get size(): number {
    return this.events.size;
  }

  state(): GroupState | null {
    return this.current;
  }

  has(eventId: string): boolean {
    return this.events.has(eventId);
  }

  /** True if the event was accepted AND had an effect in the current fold. */
  isEffective(eventId: string): boolean {
    return this.validIds.has(eventId);
  }

  ids(): string[] {
    return [...this.events.keys()];
  }

  /** Events nobody else lists as a dependency: what a new event should depend on. */
  heads(): string[] {
    const referenced = new Set<string>();
    for (const e of this.events.values()) for (const d of e.deps) referenced.add(d);
    return [...this.events.keys()].filter((id) => !referenced.has(id)).sort();
  }

  /** Accepted events in causal order (deterministic). */
  all(): GroupEvent[] {
    return this.order();
  }

  /** Events the other side does not have yet. */
  missingFor(theirIds: Iterable<string>): GroupEvent[] {
    const have = new Set(theirIds);
    return this.order().filter((e) => !have.has(e.eventId));
  }

  async add(event: unknown): Promise<AddStatus> {
    if (!isGroupEventShape(event)) return 'invalid';
    if (event.groupId !== this.groupId) return 'invalid';
    if (this.events.has(event.eventId) || this.pending.has(event.eventId)) return 'duplicate';
    if (!(await eventIdMatches(event))) return 'invalid';
    if (this.events.size >= MAX_EVENTS_PER_GROUP) return 'invalid';
    if (event.type !== 'create' && event.deps.length === 0) return 'invalid';
    if (event.deps.some((d) => !this.events.has(d))) {
      if (this.pending.size >= MAX_PENDING_EVENTS) return 'invalid';
      this.pending.set(event.eventId, event);
      return 'buffered';
    }
    this.events.set(event.eventId, event);
    await this.drainPending();
    await this.refold();
    return 'applied';
  }

  /** Ids of dependencies we are still missing (ask the peer for them). */
  missingDeps(): string[] {
    const out = new Set<string>();
    for (const e of this.pending.values()) for (const d of e.deps) if (!this.events.has(d) && !this.pending.has(d)) out.add(d);
    return [...out];
  }

  private async drainPending(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, e] of [...this.pending]) {
        if (e.deps.every((d) => this.events.has(d))) {
          this.pending.delete(id);
          this.events.set(id, e);
          progressed = true;
        }
      }
    }
  }

  private order(): GroupEvent[] {
    const indeg = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const e of this.events.values()) {
      indeg.set(e.eventId, e.deps.length);
      for (const d of e.deps) {
        const list = children.get(d) ?? [];
        list.push(e.eventId);
        children.set(d, list);
      }
    }
    const rank = (id: string): [number, string] => [this.events.get(id)!.type === 'remove' ? 0 : 1, id];
    const less = (a: string, b: string) => {
      const [pa, ia] = rank(a);
      const [pb, ib] = rank(b);
      return pa !== pb ? pa < pb : ia < ib;
    };
    const ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
    const out: GroupEvent[] = [];
    while (ready.length > 0) {
      ready.sort((a, b) => (less(a, b) ? -1 : 1));
      const id = ready.shift()!;
      out.push(this.events.get(id)!);
      for (const c of children.get(id) ?? []) {
        const n = (indeg.get(c) ?? 0) - 1;
        indeg.set(c, n);
        if (n === 0) ready.push(c);
      }
    }
    return out;
  }

  private async verifySig(e: GroupEvent, signer: ContactCard): Promise<boolean> {
    const k = `${e.eventId}|${keyId(signer.sign)}`;
    const hit = this.sigCache.get(k);
    if (hit !== undefined) return hit;
    const ok = await signatureValid(e, signer.sign);
    this.sigCache.set(k, ok);
    return ok;
  }

  private async refold(): Promise<void> {
    let state: GroupState | null = null;
    const valid = new Set<string>();
    for (const e of this.order()) {
      if (e.type === 'create') {
        if (state || e.deps.length > 0 || e.groupId !== e.eventId) continue;
        if (!(await cardIsValid(e.card, e.actor)) || !(await this.verifySig(e, e.card!))) continue;
        state = {
          groupId: e.groupId,
          name: e.name!,
          createdBy: e.actor,
          members: new Map([[e.actor, { uid: e.actor, card: e.card!, role: 'admin', addedBy: e.actor }]]),
        };
        valid.add(e.eventId);
        continue;
      }
      if (!state) continue;
      const author = state.members.get(e.actor);
      if (!author || !(await this.verifySig(e, author.card))) continue;
      if (e.type === 'add') {
        if (!(await cardIsValid(e.card, e.target!))) continue;
        if (!state.members.has(e.target!)) {
          state.members.set(e.target!, { uid: e.target!, card: e.card!, role: 'member', addedBy: e.actor });
        }
        valid.add(e.eventId);
      } else if (e.type === 'remove') {
        const selfLeave = e.actor === e.target;
        if (!selfLeave && author.role !== 'admin') continue;
        if (!state.members.has(e.target!)) continue;
        state.members.delete(e.target!);
        valid.add(e.eventId);
      } else if (e.type === 'rename') {
        if (author.role !== 'admin') continue;
        state.name = e.name!;
        valid.add(e.eventId);
      }
    }
    this.current = state;
    this.validIds = valid;
  }

  toJSON(): GroupEvent[] {
    return this.order();
  }

  static async fromJSON(groupId: string, events: unknown[]): Promise<GroupLog> {
    const log = new GroupLog(groupId);
    for (const e of events) await log.add(e);
    return log;
  }
}
