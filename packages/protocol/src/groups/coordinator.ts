import type { ContactCard } from '../connectivity/contactCard';
import { validateBlob, type SealedBlob } from '../connectivity/seal';
import type { PrivateJwk } from '../e2ee';
import { MAX_GROUP_MEMBERS } from '../constants';
import { validateClientMessageId, validateIncomingText, validateReply, type ReplyRef } from '../message';
import { isGroupEventShape, signGroupEvent, type GroupEvent } from './events';
import { GroupLog, type GroupState } from './log';

/* ---------------- wire frames (all travel over an already-authenticated pairwise channel) ---------------- */

export interface GroupPushFrame { v: 1; kind: 'group_push'; event: GroupEvent }
export interface GroupEventsFrame { v: 1; kind: 'group_events'; events: GroupEvent[] }
export interface GroupHaveFrame {
  v: 1;
  kind: 'group_have';
  groups: { groupId: string; ids: string[] }[];
  /** Sent when a link opens: `groups` is everything the sender has, so groups missing from it are unknown to them. */
  full?: true;
}
export interface GroupMessageFrame {
  v: 1;
  kind: 'gmsg';
  groupId: string;
  messageId: string;
  text: string;
  clientCreatedAt: number;
  replyTo?: ReplyRef;
}
/** Ask a mutual contact to pass a sealed blob on to someone we cannot reach directly (signaling without internet). */
export interface RelayBlobFrame { v: 1; kind: 'relay_blob'; blob: SealedBlob; hops: number }

export type GroupFrame = GroupPushFrame | GroupEventsFrame | GroupHaveFrame | GroupMessageFrame | RelayBlobFrame;

export const MAX_EVENTS_PER_FRAME = 40;
export const MAX_RELAY_HOPS = 2;

export function parseGroupFrame(value: unknown): GroupFrame | null {
  const f = value as Record<string, unknown> | null;
  if (typeof f !== 'object' || f === null || f.v !== 1) return null;
  switch (f.kind) {
    case 'group_push':
      return isGroupEventShape(f.event) ? (f as unknown as GroupPushFrame) : null;
    case 'group_events':
      return Array.isArray(f.events) && f.events.length <= MAX_EVENTS_PER_FRAME && f.events.every(isGroupEventShape)
        ? (f as unknown as GroupEventsFrame)
        : null;
    case 'group_have':
      return Array.isArray(f.groups) && f.groups.length <= 200 &&
        f.groups.every((g) => typeof g?.groupId === 'string' && Array.isArray(g.ids) && g.ids.length <= 6000 && g.ids.every((i: unknown) => typeof i === 'string'))
        ? (f as unknown as GroupHaveFrame)
        : null;
    case 'gmsg':
      return typeof f.groupId === 'string' && validateClientMessageId(f.messageId) && validateIncomingText(f.text) &&
        typeof f.clientCreatedAt === 'number' && Number.isFinite(f.clientCreatedAt) && f.clientCreatedAt > 0 &&
        (f.replyTo === undefined || validateReply(f.replyTo))
        ? (f as unknown as GroupMessageFrame)
        : null;
    case 'relay_blob':
      return validateBlob(f.blob) && typeof f.hops === 'number' && f.hops >= 0 && f.hops <= MAX_RELAY_HOPS
        ? (f as unknown as RelayBlobFrame)
        : null;
    default:
      return null;
  }
}

/* ---------------- coordinator ---------------- */

export interface OutgoingFrame { to: string; frame: GroupFrame }

export interface NewContact {
  card: ContactCard;
  uid: string;
  /** The member who brought them into the group: what the user sees as "introduced by". */
  introducedBy: string;
  groupId: string;
}

export interface GroupResult {
  /** Frames the engine should send now (to peers it has an open link to; sync repairs the rest). */
  outgoing: OutgoingFrame[];
  /** Groups whose roster or name changed, or that were just learned. */
  changed: string[];
  /** Members we have no contact for yet. The engine pins them as "introduced" and connects automatically. */
  newContacts: NewContact[];
  /** Groups in which we were just added (show "X added you"). */
  joined: string[];
  /** Groups we are no longer a member of after this update. */
  left: string[];
}

const emptyResult = (): GroupResult => ({ outgoing: [], changed: [], newContacts: [], joined: [], left: [] });

export type MessageVerdict = 'ok' | 'unknown_group' | 'not_member';

export interface CoordinatorOptions {
  ownUid: string;
  ownCard: ContactCard;
  signPriv: PrivateJwk;
  /** uids we already hold a contact for. Anyone else in a roster becomes a `newContacts` entry. */
  knownUids: () => ReadonlySet<string>;
  /** Is this uid a contact we may take group data from? Defaults to "any known contact". */
  trusted?: (uid: string) => boolean;
  now?: () => number;
}

export class GroupCoordinator {
  private logs = new Map<string, GroupLog>();

  constructor(private readonly o: CoordinatorOptions) {}

  groupIds(): string[] {
    return [...this.logs.keys()];
  }

  state(groupId: string): GroupState | null {
    return this.logs.get(groupId)?.state() ?? null;
  }

  /** Groups we are currently a member of. */
  myGroups(): GroupState[] {
    return [...this.logs.values()].map((l) => l.state()).filter((s): s is GroupState => !!s && s.members.has(this.o.ownUid));
  }

  isMember(groupId: string, uid: string): boolean {
    return this.state(groupId)?.members.has(uid) ?? false;
  }

  /** Everyone in the group except us: who a message must be delivered to. */
  recipients(groupId: string): string[] {
    const s = this.state(groupId);
    return s ? [...s.members.keys()].filter((u) => u !== this.o.ownUid) : [];
  }

  eventCount(groupId: string): number {
    return this.logs.get(groupId)?.size ?? 0;
  }

  /** Persistable form: every event of every group. */
  export(): Record<string, GroupEvent[]> {
    return Object.fromEntries([...this.logs].map(([id, log]) => [id, log.toJSON()]));
  }

  async load(saved: Record<string, unknown[]>): Promise<void> {
    for (const [groupId, events] of Object.entries(saved)) {
      this.logs.set(groupId, await GroupLog.fromJSON(groupId, events));
    }
  }

  /* ---- authoring ---- */

  async createGroup(name: string, initialMembers: ContactCard[] = []): Promise<GroupResult & { groupId: string }> {
    const create = await signGroupEvent(
      { groupId: '', type: 'create', actor: this.o.ownUid, card: this.o.ownCard, name: name.trim().slice(0, 60), ts: this.o.now?.() },
      this.o.signPriv,
    );
    const log = new GroupLog(create.groupId);
    this.logs.set(create.groupId, log);
    await log.add(create);
    if (initialMembers.length + 1 > MAX_GROUP_MEMBERS) {
      this.logs.delete(create.groupId);
      throw new Error(`A group can have at most ${MAX_GROUP_MEMBERS} members, including you.`);
    }
    const result = emptyResult();
    result.changed.push(create.groupId);
    result.joined.push(create.groupId);
    for (const card of initialMembers) {
      const r = await this.addMember(create.groupId, card);
      result.outgoing.push(...r.outgoing);
    }
    return { ...result, groupId: create.groupId };
  }

  private async author(
    groupId: string,
    input: { type: 'add' | 'remove' | 'rename'; target?: string; card?: ContactCard; name?: string },
  ): Promise<{ event: GroupEvent; result: GroupResult }> {
    const log = this.logs.get(groupId);
    const state = log?.state();
    if (!log || !state || !state.members.has(this.o.ownUid)) throw new Error('You are not a member of this group.');
    const event = await signGroupEvent(
      { groupId, actor: this.o.ownUid, deps: log.heads(), ts: this.o.now?.(), ...input },
      this.o.signPriv,
    );
    if ((await log.add(event)) !== 'applied' || !log.isEffective(event.eventId)) {
      throw new Error('That change is not allowed (for example, only an admin can remove other members).');
    }
    const result = emptyResult();
    result.changed.push(groupId);
    // Push to everyone who is a member now, plus the removed member so they learn they are out.
    const audience = new Set([...log.state()!.members.keys(), ...(input.target ? [input.target] : [])]);
    audience.delete(this.o.ownUid);
    for (const uid of audience) {
      // A newly added member gets the whole history of the roster so they can verify and meet everyone.
      if (event.type === 'add' && uid === event.target) {
        result.outgoing.push(...this.chunk(uid, log.all()));
      } else {
        result.outgoing.push({ to: uid, frame: { v: 1, kind: 'group_push', event } });
      }
    }
    const after = log.state()!;
    if (!after.members.has(this.o.ownUid)) result.left.push(groupId);
    return { event, result };
  }

  async addMember(groupId: string, card: ContactCard): Promise<GroupResult> {
    const uid = await uidOf(card);
    if (this.isMember(groupId, uid)) throw new Error('Already in this group.');
    if ((this.state(groupId)?.members.size ?? 0) >= MAX_GROUP_MEMBERS) {
      throw new Error(`This group is full (${MAX_GROUP_MEMBERS} members is the limit).`);
    }
    return (await this.author(groupId, { type: 'add', target: uid, card })).result;
  }

  async removeMember(groupId: string, uid: string): Promise<GroupResult> {
    return (await this.author(groupId, { type: 'remove', target: uid })).result;
  }

  async leave(groupId: string): Promise<GroupResult> {
    return (await this.author(groupId, { type: 'remove', target: this.o.ownUid })).result;
  }

  async rename(groupId: string, name: string): Promise<GroupResult> {
    return (await this.author(groupId, { type: 'rename', name: name.trim().slice(0, 60) })).result;
  }

  /* ---- link lifecycle ---- */

  /** Call when a verified link to `peerUid` opens: tell them what we have for groups they belong to. */
  onLinkOpen(peerUid: string): OutgoingFrame[] {
    const groups: GroupHaveFrame['groups'] = [];
    for (const [groupId, log] of this.logs) {
      const s = log.state();
      if (s?.members.has(peerUid)) {
        groups.push({ groupId, ids: log.ids() });
      }
    }
    // Always sent, even when empty: the peer pushes us the groups we do not have yet (see `handle`).
    return [{ to: peerUid, frame: { v: 1, kind: 'group_have', groups, full: true } }];
  }

  /* ---- receiving ---- */

  async handle(fromUid: string, frame: GroupFrame): Promise<GroupResult> {
    const result = emptyResult();
    if (frame.kind === 'group_push') {
      await this.applyEvents(fromUid, [frame.event], result);
    } else if (frame.kind === 'group_events') {
      await this.applyEvents(fromUid, frame.events, result);
    } else if (frame.kind === 'group_have') {
      for (const g of frame.groups) {
        const log = this.logs.get(g.groupId);
        const s = log?.state();
        // Only members may pull a group's history; everyone else learns nothing, not even that it exists.
        if (!log || !s || !s.members.has(fromUid)) continue;
        const missing = log.missingFor(g.ids);
        if (missing.length > 0) result.outgoing.push(...this.chunk(fromUid, missing));
        // If they know events we lack, ask them for those by replying with what we have.
        const mine = new Set(log.ids());
        if (g.ids.some((id) => !mine.has(id))) {
          result.outgoing.push({ to: fromUid, frame: { v: 1, kind: 'group_have', groups: [{ groupId: g.groupId, ids: log.ids() }] } });
        }
      }
      if (frame.full === true) {
        // They listed everything they have: any group of ours they belong to but did not list is new to them.
        const listed = new Set(frame.groups.map((g) => g.groupId));
        for (const [groupId, log] of this.logs) {
          if (listed.has(groupId) || !log.state()?.members.has(fromUid)) continue;
          result.outgoing.push(...this.chunk(fromUid, log.missingFor([])));
        }
      }
    }
    return result;
  }

  /** Should a group message from `fromUid` be accepted right now? */
  checkMessage(fromUid: string, groupId: string): MessageVerdict {
    const s = this.state(groupId);
    if (!s) return 'unknown_group';
    return s.members.has(fromUid) && s.members.has(this.o.ownUid) ? 'ok' : 'not_member';
  }

  /** Ask a peer for the group's history (used when a message arrives for a group/sender we do not know yet). */
  requestSync(peerUid: string, groupId?: string): OutgoingFrame[] {
    const groups = [...this.logs].filter(([id]) => !groupId || id === groupId).map(([id, l]) => ({ groupId: id, ids: l.ids() }));
    return [{ to: peerUid, frame: { v: 1, kind: 'group_have', groups } }];
  }

  private chunk(to: string, events: GroupEvent[]): OutgoingFrame[] {
    const out: OutgoingFrame[] = [];
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_FRAME) {
      out.push({ to, frame: { v: 1, kind: 'group_events', events: events.slice(i, i + MAX_EVENTS_PER_FRAME) } });
    }
    return out;
  }

  /**
   * Whether we take group events from this peer. Integrity does not depend on this check: every event is
   * signature-checked and authorised against the roster. It only bounds spam and storage, so a trusted
   * contact is enough, and so is a current member (who may not be in our contact list yet).
   */
  private canAccept(fromUid: string, groupId: string): boolean {
    if (this.logs.get(groupId)?.state()?.members.has(fromUid)) return true;
    return this.o.trusted ? this.o.trusted(fromUid) : this.o.knownUids().has(fromUid);
  }

  private async applyEvents(fromUid: string, events: GroupEvent[], result: GroupResult): Promise<void> {
    const touched = new Set<string>();
    // Decide per group BEFORE applying anything: within one batch the sender may only become a member
    // (and so pass the check) after an earlier event of the same batch is applied.
    const accepted = new Map<string, boolean>();
    for (const event of events) {
      if (!accepted.has(event.groupId)) accepted.set(event.groupId, this.canAccept(fromUid, event.groupId));
    }
    for (const event of events) {
      if (!accepted.get(event.groupId)) continue;
      let log = this.logs.get(event.groupId);
      const isNew = !log;
      if (!log) {
        log = new GroupLog(event.groupId);
        this.logs.set(event.groupId, log);
      }
      const wasMember = log.state()?.members.has(this.o.ownUid) ?? false;
      const status = await log.add(event);
      if (isNew && status === 'invalid') {
        this.logs.delete(event.groupId);
        continue;
      }
      if (status === 'applied') {
        touched.add(event.groupId);
        if (!wasMember && log.state()?.members.has(this.o.ownUid)) result.joined.push(event.groupId);
        // Gossip the news: members we may be linked to but the author could not reach.
        const s = log.state();
        if (s) {
          for (const uid of s.members.keys()) {
            if (uid !== this.o.ownUid && uid !== fromUid && uid !== event.actor) {
              result.outgoing.push({ to: uid, frame: { v: 1, kind: 'group_push', event } });
            }
          }
        }
      } else if (status === 'buffered') {
        // We are missing earlier events: ask this peer for the whole group.
        result.outgoing.push(...this.requestSync(fromUid, event.groupId));
      }
    }
    for (const groupId of touched) {
      const log = this.logs.get(groupId)!;
      const s = log.state();
      if (!s || !s.members.has(this.o.ownUid)) {
        // Never a member (spam from a contact): forget it. Previously a member: keep it, we were removed.
        const everMember = log.all().some((e) => (e.type === 'add' && e.target === this.o.ownUid) || (e.type === 'create' && e.actor === this.o.ownUid));
        if (!everMember) {
          this.logs.delete(groupId);
          continue;
        }
        if (s && !result.left.includes(groupId)) result.left.push(groupId);
      }
      result.changed.push(groupId);
      if (s && s.members.has(this.o.ownUid)) {
        const known = this.o.knownUids();
        for (const m of s.members.values()) {
          if (m.uid !== this.o.ownUid && !known.has(m.uid) && !result.newContacts.some((c) => c.uid === m.uid)) {
            result.newContacts.push({ card: m.card, uid: m.uid, introducedBy: m.addedBy, groupId });
          }
        }
      }
    }
  }
}

async function uidOf(card: ContactCard): Promise<string> {
  const { uidFromDh } = await import('../connectivity/contactCard');
  return uidFromDh(card.dh);
}
