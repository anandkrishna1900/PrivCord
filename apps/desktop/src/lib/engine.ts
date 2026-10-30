import {
  GroupCoordinator,
  compareMessages,
  createManualSignal,
  createOutgoingMessage,
  createPeerMessageFrame,
  decodeContactCard,
  decodeManualSignal,
  deriveSafetyNumber,
  ecdhAgree,
  encodeManualSignal,
  isRecord,
  mailboxFor,
  open as openBlob,
  parseGroupFrame,
  parsePeerFrame,
  parsePeerMessageFrame,
  randomNonce,
  reconnectDelayMs,
  seal,
  type ConnectionPath,
  type ContactCard,
  type DeliveryState,
  type GroupFrame,
  type GroupResult,
  type NetworkConfig,
  type SealedBlob,
} from '@duochat/protocol';
import {
  contactCardOf,
  loadPairing,
  uidMatchesKeys,
  type DeviceIdentity,
} from './identity';
import { loadNetworkConfig, rtcConfigFor } from './network';
import { SignalingHub, transportsFor } from './signaling/hub';
import type { SignalingStatus, SignalingTransport } from './signaling/types';
import { LocalStore, type StoredMessage } from './localDb';
import { PeerLink, type LinkContact } from './peerLink';
import { SecureBleLink, getBleBridge } from './bleLink';
import type { BleBridge } from './ble';
import { loadSettings } from './settings';

/* ============================== public shapes (what the UI reads) ============================== */

export type EnginePhase = 'starting' | 'ready' | 'error' | 'stopped';
export type Trust = 'verified' | 'introduced';
export type ConnState = 'connected' | 'connecting' | 'offline';

export interface ContactRecord {
  uid: string;
  card: ContactCard;
  trust: Trust;
  /** uid of the member who introduced them (trust = introduced). */
  introducedBy?: string;
  nickname?: string;
  /** The user compared the safety number with them. */
  checked: boolean;
  addedAt: number;
}

export interface LastMessage {
  text: string;
  at: number;
  own: boolean;
  senderName?: string;
}

export interface ContactView {
  uid: string;
  name: string;
  trust: Trust;
  checked: boolean;
  introducedBy?: string;
  introducedByName?: string;
  conn: ConnState;
  path: ConnectionPath | null;
  via: 'webrtc' | 'ble' | null;
  unread: number;
  last?: LastMessage;
  /** Plain-language status line. */
  status: string;
}

export interface MemberView {
  uid: string;
  name: string;
  role: 'admin' | 'member';
  isMe: boolean;
  addedBy: string;
  addedByName: string;
  conn: ConnState;
  introducedHere: boolean;
}

export interface GroupView {
  groupId: string;
  name: string;
  /** `member`: active. `removed` / `left`: read-only. */
  status: 'member' | 'removed' | 'left';
  members: MemberView[];
  amAdmin: boolean;
  connected: number;
  unread: number;
  last?: LastMessage;
}

export interface UiMessage extends StoredMessage {
  own: boolean;
  senderName: string;
  /** What the tick shows: the weakest recipient. */
  tick: DeliveryState;
  delivered: number;
  total: number;
}

export interface ChatState {
  phase: EnginePhase;
  uid: string;
  contacts: ContactView[];
  groups: GroupView[];
  messages: Record<string, UiMessage[]>;
  signaling: SignalingStatus;
  storageBackend: 'sqlite' | 'browser';
  /** Messages waiting for someone to come online. */
  queued: number;
  error: string | null;
  notice: string | null;
}

export interface EngineDeps {
  identity: DeviceIdentity;
  /** Same string on both sides; part of the identity proof. */
  context: string;
  store: LocalStore;
  /** `title` is already worded for the user ("Sam" or "Sam in Trip"). */
  onNotify: (message: StoredMessage, title: string) => void;
}

/* ============================== internals ============================== */

const TICK_MS = 2_000;
const PING_MS = 4_000;
const MAX_CONNECTING = 3;
const SOFT_LINK_CAP = 30;
const PENDING_GROUP_MS = 60_000;
const RANK: Record<DeliveryState, number> = { QUEUED: 0, FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const maxState = (a: DeliveryState, b: DeliveryState): DeliveryState => (RANK[b] > RANK[a] ? b : a);
const short = (uid: string) => uid.slice(0, 6);

function aggregate(recipients: Record<string, DeliveryState> | undefined): DeliveryState {
  const values = Object.values(recipients ?? {});
  if (values.length === 0) return 'SENT';
  return values.reduce((weakest, s) => (RANK[s] < RANK[weakest] ? s : weakest));
}

export class ChatEngine {
  private state: ChatState;
  private listeners = new Set<(state: ChatState) => void>();
  private identity: DeviceIdentity;
  private network: NetworkConfig = loadNetworkConfig();
  private hub: SignalingHub | null = null;
  private contacts = new Map<string, ContactRecord>();
  private links = new Map<string, PeerLink>();
  private msgs = new Map<string, StoredMessage>();
  private coord: GroupCoordinator;
  private ownName: string | null = null;
  private known = new Set<string>();
  private pendingGroup = new Map<string, { from: string; frame: Extract<GroupFrame, { kind: 'gmsg' }>; at: number }>();
  private seenBlobs = new Set<string>();
  private relayed = new Set<string>();
  private lastPing = new Map<string, number>();
  private active: string | null = null;
  private visible = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking = false;
  private bleBridge: BleBridge | null | undefined;
  private bleBusy = false;
  private bleNext = new Map<string, { at: number; attempt: number }>();
  private groupNotes = new Map<string, 'left' | 'removed'>();

  constructor(private readonly deps: EngineDeps) {
    this.identity = deps.identity;
    this.coord = this.newCoordinator();
    this.state = {
      phase: 'starting',
      uid: deps.identity.uid,
      contacts: [],
      groups: [],
      messages: {},
      signaling: 'idle',
      storageBackend: deps.store.backend,
      queued: 0,
      error: null,
      notice: null,
    };
  }

  /* ---------------- plumbing ---------------- */

  getState(): ChatState {
    return this.state;
  }

  get localStore(): LocalStore {
    return this.deps.store;
  }

  get identityDetails(): DeviceIdentity {
    return this.identity;
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private newCoordinator(): GroupCoordinator {
    return new GroupCoordinator({
      ownUid: this.identity.uid,
      ownCard: JSON.parse(JSON.stringify(this.ownCard())),
      signPriv: this.identity.privateJwk,
      knownUids: () => this.known,
    });
  }

  /** The name on our invite changed: groups we add people to from now on carry the new name. */
  async refreshOwnName(name: string): Promise<void> {
    this.ownName = name.trim();
    const saved = this.coord.export();
    this.coord = this.newCoordinator();
    await this.coord.load(saved);
  }

  private ownCard(): ContactCard {
    const text = contactCardOf(this.identity, (this.ownName ?? loadSettings().displayName) || undefined);
    return decodeCardSync(text);
  }

  /** The text a friend scans or pastes to add us. */
  myInvite(): string {
    return contactCardOf(this.identity, (this.ownName ?? loadSettings().displayName) || undefined);
  }

  private emit(patch: Partial<ChatState> = {}): void {
    this.state = { ...this.build(), ...patch, notice: patch.notice !== undefined ? patch.notice : this.state.notice, error: patch.error !== undefined ? patch.error : this.state.error };
    for (const listener of this.listeners) listener(this.state);
  }

  clearNotice(): void {
    this.emit({ notice: null, error: null });
  }

  private notice(text: string | null): void {
    this.emit({ notice: text });
  }

  /* ---------------- names ---------------- */

  private nameOf(uid: string): string {
    if (uid === this.identity.uid) return 'You';
    const c = this.contacts.get(uid);
    if (c?.nickname) return c.nickname;
    if (c?.card.name) return c.card.name;
    for (const g of this.coord.myGroups()) {
      const m = g.members.get(uid);
      if (m?.card.name) return m.card.name;
    }
    return `Friend ${short(uid)}`;
  }

  private conn(uid: string): ConnState {
    const link = this.links.get(uid);
    if (link?.ready) return 'connected';
    return link?.state === 'connecting' ? 'connecting' : 'offline';
  }

  /* ---------------- start / stop ---------------- */

  async start(): Promise<void> {
    try {
      await this.deps.store.init();
      if (this.stopped) return;
      await this.loadContacts();
      await this.coord.load((await this.deps.store.getSecret<Record<string, unknown[]>>('groups')) ?? {});
      const stored = await this.deps.store.loadMessages();
      for (const m of stored) this.msgs.set(m.messageId, m);
      await this.migrateLegacy();
      if (this.stopped) return;
      this.startSignaling();
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.state = { ...this.state, phase: 'ready', storageBackend: this.deps.store.backend };
      if (this.deps.store.initError) {
        this.state.notice = `SQLite was unavailable (${this.deps.store.initError}); this browser development store is not secure.`;
      }
      this.emit();
      void this.tick();
    } catch (error) {
      if (!this.stopped) this.emit({ phase: 'error', error: errorMessage(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.hub?.stop();
    this.hub = null;
    for (const link of this.links.values()) link.close();
    this.state = { ...this.state, phase: 'stopped' };
    for (const listener of this.listeners) listener(this.state);
  }

  /* ---------------- contacts ---------------- */

  private async loadContacts(): Promise<void> {
    const saved = (await this.deps.store.getSecret<ContactRecord[]>('contacts')) ?? [];
    for (const rec of saved) this.registerContact(rec, false);
  }

  private persistContacts(): void {
    void this.deps.store.setSecret('contacts', [...this.contacts.values()]).catch(() => undefined);
  }

  private persistGroups(): void {
    void this.deps.store.setSecret('groups', this.coord.export()).catch(() => undefined);
  }

  private registerContact(rec: ContactRecord, persist = true): PeerLink {
    this.contacts.set(rec.uid, rec);
    this.known.add(rec.uid);
    let link = this.links.get(rec.uid);
    if (!link) {
      link = new PeerLink({ uid: rec.uid, sign: rec.card.sign, dh: rec.card.dh }, this.linkEnv());
      this.links.set(rec.uid, link);
    }
    if (persist) this.persistContacts();
    return link;
  }

  /** Move a pre-groups install (one pinned peer, unlabeled messages) into the new model. */
  private async migrateLegacy(): Promise<void> {
    const legacy = loadPairing();
    if (legacy?.dhJwk && !this.contacts.has(legacy.peerUid) && this.contacts.size === 0) {
      let nickname: string | undefined;
      try {
        const raw = JSON.parse(localStorage.getItem('duochat.settings.v1') ?? '{}') as { peerNickname?: unknown };
        if (typeof raw.peerNickname === 'string' && raw.peerNickname.trim()) nickname = raw.peerNickname.trim().slice(0, 40);
      } catch {
        // No old nickname.
      }
      this.registerContact({
        uid: legacy.peerUid,
        card: { v: 1, sign: legacy.publicKeyJwk, dh: legacy.dhJwk, proof: '', ...(nickname ? { name: nickname } : {}) },
        trust: 'verified',
        checked: true,
        addedAt: legacy.pairedAt,
      });
    }
    const only = this.contacts.size === 1 ? [...this.contacts.keys()][0]! : null;
    for (const m of this.msgs.values()) {
      if (m.conversationId) continue;
      if (!only) {
        m.conversationId = '__legacy';
        continue;
      }
      m.conversationId = only;
      m.recipients = m.senderId === this.identity.uid ? { [only]: m.deliveryState } : undefined;
      void this.deps.store.updateMessage(m.messageId, { conversationId: only, ...(m.recipients ? { recipients: m.recipients } : {}) });
    }
  }

  /** Validate an invite without saving anything. */
  async previewInvite(text: string): Promise<{ uid: string; name: string; safetyNumber: string; already: boolean }> {
    const contact = await decodeContactCard(text);
    if (!contact) throw new Error('That does not look like a PrivCord invite. Ask your friend to share it again.');
    if (contact.uid === this.identity.uid) throw new Error('That is your own invite. Send it to a friend instead.');
    return {
      uid: contact.uid,
      name: contact.card.name || `Friend ${short(contact.uid)}`,
      safetyNumber: await deriveSafetyNumber(this.identity.publicJwk, contact.card.sign),
      already: this.contacts.get(contact.uid)?.trust === 'verified',
    };
  }

  /** Save a friend from their invite. Returns their uid so the UI can open the chat. */
  async addContact(text: string): Promise<string> {
    const contact = await decodeContactCard(text);
    if (!contact) throw new Error('That does not look like a PrivCord invite. Ask your friend to share it again.');
    if (contact.uid === this.identity.uid) throw new Error('That is your own invite. Send it to a friend instead.');
    const existing = this.contacts.get(contact.uid);
    const rec: ContactRecord = {
      uid: contact.uid,
      card: contact.card,
      trust: 'verified',
      introducedBy: undefined,
      nickname: existing?.nickname,
      checked: existing?.checked ?? false,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    const link = this.registerContact(rec);
    link.lastOfferAt = 0;
    link.offerAttempt = 0;
    this.emit({ notice: existing ? `${this.nameOf(contact.uid)} is already in your friends.` : `${this.nameOf(contact.uid)} added. Connecting…` });
    void this.tick();
    return contact.uid;
  }

  setChecked(uid: string): void {
    const rec = this.contacts.get(uid);
    if (!rec) return;
    rec.checked = true;
    this.persistContacts();
    this.emit();
  }

  async safetyNumberFor(uid: string): Promise<string> {
    const rec = this.contacts.get(uid);
    if (!rec) throw new Error('Unknown friend.');
    return deriveSafetyNumber(this.identity.publicJwk, rec.card.sign);
  }

  setNickname(uid: string, name: string): void {
    const rec = this.contacts.get(uid);
    if (!rec) return;
    rec.nickname = name.trim().slice(0, 40) || undefined;
    this.persistContacts();
    this.emit();
  }

  /** Forget a friend. Refused while they share a group with us, because the group would bring them straight back. */
  removeContact(uid: string): void {
    if (this.coord.myGroups().some((g) => g.members.has(uid))) {
      throw new Error('Leave the groups you share first, then you can remove this friend.');
    }
    this.links.get(uid)?.close();
    this.links.delete(uid);
    this.contacts.delete(uid);
    this.known.delete(uid);
    for (const [id, m] of [...this.msgs]) if (m.conversationId === uid) this.msgs.delete(id);
    this.persistContacts();
    this.emit();
  }

  /* ---------------- link wiring ---------------- */

  private linkEnv() {
    return {
      identity: this.identity,
      context: this.deps.context,
      rtcConfig: () => rtcConfigFor(this.network),
      onReady: (link: PeerLink) => this.onLinkReady(link),
      onClosed: () => this.emit(),
      onFrame: (link: PeerLink, frame: unknown) => void this.onFrame(link, frame),
      onChange: () => this.emit(),
      onNotice: (text: string) => this.notice(text),
      onProof: (link: PeerLink, hello: { publicKeyJwk: JsonWebKey; dhJwk: JsonWebKey; identityProof: string }) => {
        const rec = this.contacts.get(link.uid);
        if (rec && rec.card.proof !== hello.identityProof) {
          rec.card = { ...rec.card, proof: hello.identityProof };
          this.persistContacts();
        }
      },
    };
  }

  private onLinkReady(link: PeerLink): void {
    const uid = link.uid;
    this.lastPing.set(uid, Date.now());
    for (const out of this.coord.onLinkOpen(uid)) this.sendFrame(out.to, out.frame);
    this.flush(uid);
    if (this.active === uid && this.visible) this.markRead(uid);
    this.emit({ notice: `${this.nameOf(uid)} is connected.` });
  }

  private sendFrame(uid: string, frame: unknown): boolean {
    return this.links.get(uid)?.sendJson(frame) ?? false;
  }

  /* ---------------- sending ---------------- */

  private recipientsOfConversation(convId: string): string[] {
    if (this.contacts.has(convId)) return [convId];
    return this.coord.recipients(convId);
  }

  async send(convId: string, rawText: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const isGroup = !this.contacts.has(convId);
      if (isGroup) {
        const s = this.coord.state(convId);
        if (!s || !s.members.has(this.identity.uid)) return { ok: false, error: 'You are not in this group any more.' };
      } else if (!this.contacts.has(convId)) {
        return { ok: false, error: 'Unknown chat.' };
      }
      const base = createOutgoingMessage({ senderId: this.identity.uid, text: rawText });
      const recipients: Record<string, DeliveryState> = {};
      for (const uid of this.recipientsOfConversation(convId)) recipients[uid] = 'QUEUED';
      const message: StoredMessage = { ...base, conversationId: convId, recipients, deliveryState: Object.keys(recipients).length ? 'QUEUED' : 'SENT' };
      this.msgs.set(message.messageId, message);
      await this.deps.store.putMessage(message);
      for (const uid of Object.keys(recipients)) this.deliver(message, uid);
      void this.relayPending();
      this.emit();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async retry(messageId: string): Promise<void> {
    const m = this.msgs.get(messageId);
    if (!m || m.senderId !== this.identity.uid) return;
    for (const uid of Object.keys(m.recipients ?? {})) {
      this.links.get(uid)?.sent.delete(messageId);
      this.deliver(m, uid);
    }
    this.emit();
  }

  private frameFor(m: StoredMessage): unknown {
    if (this.contacts.has(m.conversationId)) return createPeerMessageFrame(m);
    return { v: 1, kind: 'gmsg', groupId: m.conversationId, messageId: m.messageId, text: m.text, clientCreatedAt: m.clientCreatedAt };
  }

  /** Write one message to one recipient if their channel is up. */
  private deliver(m: StoredMessage, uid: string): void {
    const state = m.recipients?.[uid];
    if (!state || RANK[state] >= RANK.DELIVERED) return;
    const link = this.links.get(uid);
    if (!link?.ready || link.sent.has(m.messageId)) return;
    if (!link.sendJson(this.frameFor(m))) return;
    link.sent.add(m.messageId);
    this.setRecipient(m, uid, 'SENT');
  }

  private setRecipient(m: StoredMessage, uid: string, state: DeliveryState): void {
    const recipients = { ...(m.recipients ?? {}) };
    recipients[uid] = maxState(recipients[uid] ?? 'QUEUED', state);
    m.recipients = recipients;
    m.deliveryState = aggregate(recipients);
    void this.deps.store.updateMessage(m.messageId, { recipients, deliveryState: m.deliveryState }).catch(() => undefined);
  }

  /** Everything still owed to this contact, oldest first. */
  private flush(uid: string): void {
    const own = [...this.msgs.values()]
      .filter((m) => m.senderId === this.identity.uid && m.recipients?.[uid] && RANK[m.recipients[uid]!] < RANK.DELIVERED)
      .sort(compareMessages);
    for (const m of own) this.deliver(m, uid);
    this.emit();
  }

  /* ---------------- receiving ---------------- */

  private async onFrame(link: PeerLink, raw: unknown): Promise<void> {
    const uid = link.uid;
    const control = parsePeerFrame(raw);
    if (control?.kind === 'ack') {
      const m = this.msgs.get(control.messageId);
      if (m && m.senderId === this.identity.uid && m.recipients?.[uid]) {
        this.setRecipient(m, uid, control.state === 'READ' ? 'READ' : 'DELIVERED');
        this.emit();
      }
      return;
    }
    if (control?.kind === 'read') {
      this.applyRead(uid, control.lastReadMessageId);
      return;
    }
    const direct = parsePeerMessageFrame(raw);
    if (direct) {
      if (direct.senderId !== uid) return;
      this.ingest({ ...direct, conversationId: uid, readAt: null }, uid, uid, this.nameOf(uid));
      return;
    }
    const group = parseGroupFrame(raw);
    if (!group) return;
    if (group.kind === 'gmsg') {
      await this.receiveGroupMessage(uid, group);
    } else if (group.kind === 'relay_blob') {
      this.relayBlob(uid, group);
    } else {
      await this.applyGroupResult(await this.coord.handle(uid, group), uid);
    }
  }

  /** Store a message from `from`, acknowledge it, notify. Duplicate ids are acknowledged and ignored. */
  private ingest(message: StoredMessage, from: string, convId: string, title: string): void {
    const exists = this.msgs.has(message.messageId);
    if (!exists) {
      message.deliveryState = 'DELIVERED';
      if (this.active === convId && this.visible) message.readAt = Date.now();
      this.msgs.set(message.messageId, message);
      void this.deps.store.putMessage(message).catch(() => undefined);
      if (!(this.active === convId && this.visible)) this.deps.onNotify(message, title);
    }
    this.sendFrame(from, { v: 1, kind: 'ack', messageId: message.messageId, state: 'DELIVERED', at: Date.now() });
    if (!exists && this.contacts.has(convId) && this.active === convId && this.visible) this.markRead(convId);
    this.emit();
  }

  private async receiveGroupMessage(from: string, frame: Extract<GroupFrame, { kind: 'gmsg' }>): Promise<void> {
    const verdict = this.coord.checkMessage(from, frame.groupId);
    if (verdict === 'ok') {
      const state = this.coord.state(frame.groupId)!;
      this.ingest(
        {
          messageId: frame.messageId,
          clientMessageId: frame.messageId,
          senderId: from,
          text: frame.text,
          clientCreatedAt: frame.clientCreatedAt,
          type: 'text',
          transport: 'p2p',
          deliveryState: 'DELIVERED',
          readAt: null,
          conversationId: frame.groupId,
        },
        from,
        frame.groupId,
        `${this.nameOf(from)} in ${state.name}`,
      );
      return;
    }
    // We may simply not have the roster yet: hold the message, ask for the history, retry for a minute.
    if (this.pendingGroup.size < 200) this.pendingGroup.set(frame.messageId, { from, frame, at: Date.now() });
    for (const out of this.coord.requestSync(from, frame.groupId)) this.sendFrame(out.to, out.frame);
  }

  private async retryPending(): Promise<void> {
    for (const [id, p] of [...this.pendingGroup]) {
      if (Date.now() - p.at > PENDING_GROUP_MS) {
        this.pendingGroup.delete(id);
        continue;
      }
      if (this.coord.checkMessage(p.from, p.frame.groupId) === 'ok') {
        this.pendingGroup.delete(id);
        await this.receiveGroupMessage(p.from, p.frame);
      }
    }
  }

  private applyRead(uid: string, lastId: string): void {
    const last = this.msgs.get(lastId);
    if (!last || last.conversationId !== uid) return;
    for (const m of this.msgs.values()) {
      if (m.conversationId === uid && m.senderId === this.identity.uid && m.clientCreatedAt <= last.clientCreatedAt) {
        this.setRecipient(m, uid, 'READ');
      }
    }
    this.emit();
  }

  /* ---------------- reading state ---------------- */

  openConversation(convId: string | null): void {
    this.active = convId;
    if (convId && this.visible) this.markRead(convId);
    this.emit();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.active) this.markRead(this.active);
  }

  private markRead(convId: string): void {
    let last: StoredMessage | undefined;
    let changed = false;
    const now = Date.now();
    for (const m of [...this.msgs.values()].sort(compareMessages)) {
      if (m.conversationId !== convId || m.senderId === this.identity.uid) continue;
      last = m;
      if (m.readAt == null) {
        m.readAt = now;
        changed = true;
        void this.deps.store.updateMessage(m.messageId, { readAt: now }).catch(() => undefined);
      }
    }
    if (last && this.contacts.has(convId)) this.sendFrame(convId, { v: 1, kind: 'read', lastReadMessageId: last.messageId, at: now });
    if (changed) this.emit();
  }

  /* ---------------- groups ---------------- */

  async createGroup(name: string, memberUids: string[]): Promise<string> {
    const cards: ContactCard[] = [];
    for (const uid of memberUids) {
      const rec = this.contacts.get(uid);
      if (!rec) throw new Error('Pick friends from your list.');
      if (!rec.card.proof) throw new Error(`${this.nameOf(uid)} needs to connect once before being added to a group.`);
      cards.push(rec.card);
    }
    const r = await this.coord.createGroup(name.trim() || 'New group', cards);
    await this.applyGroupResult(r);
    return r.groupId;
  }

  async addGroupMember(groupId: string, uid: string): Promise<void> {
    const rec = this.contacts.get(uid);
    if (!rec) throw new Error('Pick a friend from your list.');
    if (!rec.card.proof) throw new Error(`${this.nameOf(uid)} needs to connect once before being added to a group.`);
    await this.applyGroupResult(await this.coord.addMember(groupId, rec.card));
  }

  async removeGroupMember(groupId: string, uid: string): Promise<void> {
    await this.applyGroupResult(await this.coord.removeMember(groupId, uid));
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.groupNotes.set(groupId, 'left');
    await this.applyGroupResult(await this.coord.leave(groupId));
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    await this.applyGroupResult(await this.coord.rename(groupId, name));
  }

  private async applyGroupResult(r: GroupResult, fromUid?: string): Promise<void> {
    for (const out of r.outgoing) this.sendFrame(out.to, out.frame);
    for (const c of r.newContacts) {
      if (this.contacts.has(c.uid)) continue;
      const link = this.registerContact({
        uid: c.uid,
        card: c.card,
        trust: 'introduced',
        introducedBy: c.introducedBy,
        checked: false,
        addedAt: Date.now(),
      });
      link.lastOfferAt = 0;
    }
    for (const groupId of r.joined) {
      const s = this.coord.state(groupId);
      const adder = s?.members.get(this.identity.uid)?.addedBy;
      if (s && adder && adder !== this.identity.uid) this.notice(`${this.nameOf(adder)} added you to "${s.name}".`);
    }
    for (const groupId of r.left) {
      if (!this.groupNotes.has(groupId)) this.groupNotes.set(groupId, 'removed');
    }
    if (r.changed.length > 0 || r.newContacts.length > 0) {
      this.persistGroups();
      await this.retryPending();
    }
    // A message to a member we only just learned about must still reach them: nothing to do here,
    // they were not recipients when it was written. New contacts get connected by the timer.
    void fromUid;
    this.emit();
    if (r.newContacts.length > 0) void this.tick();
  }

  /* ---------------- signaling ---------------- */

  reloadNetwork(): void {
    this.network = loadNetworkConfig();
    this.startSignaling(true);
    this.notice('Network settings applied. They take effect on the next connection.');
  }

  private startSignaling(force = false): void {
    if (this.stopped || (this.hub && !force)) return;
    this.hub?.stop();
    this.hub = null;
    if (this.network.signaling.length === 0) {
      this.emit({ signaling: 'idle' });
      return;
    }
    const hub = new SignalingHub(transportsFor(this.network));
    this.hub = hub;
    void mailboxFor(this.identity.uid).then((mailbox) => {
      if (this.hub !== hub || this.stopped) return;
      hub.start(mailbox, (blob, id, via) => void this.handleBlob(blob, id, via));
    });
  }

  private async sealTo(uid: string, payload: unknown): Promise<{ blob: SealedBlob; mailbox: string } | null> {
    const rec = this.contacts.get(uid);
    if (!rec) return null;
    const blob = await seal({
      payload,
      fromUid: this.identity.uid,
      toUid: uid,
      toDh: rec.card.dh,
      signPriv: this.identity.privateJwk,
    });
    return { blob, mailbox: await mailboxFor(uid) };
  }

  /** Send a sealed payload to a contact: through signaling if we have it, else through a mutual contact. */
  private async putTo(uid: string, payload: unknown, kind: 'sig' | 'msg', ttlSec: number): Promise<void> {
    const sealed = await this.sealTo(uid, payload);
    if (!sealed) throw new Error('Unknown friend.');
    let sent = false;
    if (this.hub && this.hub.status() === 'online') {
      try {
        await this.hub.put(sealed.mailbox, sealed.blob, { kind, ttlSec });
        sent = true;
      } catch {
        // fall through to the mutual-contact path
      }
    }
    if (kind === 'sig' && !sent) sent = this.forwardVia(uid, sealed.blob);
    if (!sent) throw new Error('No way to reach them right now.');
  }

  /** Ask up to two connected contacts to hand a sealed blob to `uid` (signaling without the internet). */
  private forwardVia(uid: string, blob: SealedBlob): boolean {
    let n = 0;
    for (const link of this.links.values()) {
      if (link.uid === uid || !link.ready) continue;
      if (link.sendJson({ v: 1, kind: 'relay_blob', blob, hops: 1 })) n += 1;
      if (n >= 2) break;
    }
    return n > 0;
  }

  private relayBlob(from: string, frame: Extract<GroupFrame, { kind: 'relay_blob' }>): void {
    if (frame.blob.to === this.identity.uid) {
      void this.handleBlob(frame.blob, '', null);
      return;
    }
    const target = this.links.get(frame.blob.to);
    if (target?.ready && frame.hops < 2 && target.uid !== from) target.sendJson({ ...frame, hops: frame.hops + 1 });
  }

  private async handleBlob(blob: SealedBlob, id: string, via: SignalingTransport | null): Promise<void> {
    if (this.seenBlobs.has(blob.sig)) return;
    this.seenBlobs.add(blob.sig);
    if (this.seenBlobs.size > 4000) this.seenBlobs.delete(this.seenBlobs.values().next().value as string);
    const rec = this.contacts.get(blob.from);
    const link = this.links.get(blob.from);
    if (!rec || !link) return;
    const payload = await openBlob({
      blob,
      ownUid: this.identity.uid,
      ownDhPriv: this.identity.dhPrivateJwk,
      senderSign: rec.card.sign,
      senderUid: rec.uid,
    });
    if (!isRecord(payload)) return;
    try {
      switch (payload.t) {
        case 'ready':
          if (link.isInitiator()) link.lastOfferAt = 0;
          return;
        case 'offer': {
          if (link.isInitiator() || link.manual || link.ready || typeof payload.sdp !== 'string') return;
          const answer = await link.acceptOffer(payload.sdp);
          await this.putTo(rec.uid, { t: 'answer', sdp: answer }, 'sig', 120);
          return;
        }
        case 'answer':
          if (link.isInitiator() && typeof payload.sdp === 'string') await link.applyAnswer(payload.sdp);
          return;
        case 'msg': {
          if (typeof payload.id !== 'string' || typeof payload.text !== 'string' || typeof payload.at !== 'number') return;
          const gid = typeof payload.g === 'string' ? payload.g : null;
          if (gid) {
            const frame = parseGroupFrame({ v: 1, kind: 'gmsg', groupId: gid, messageId: payload.id, text: payload.text, clientCreatedAt: payload.at });
            if (frame?.kind === 'gmsg') await this.receiveGroupMessage(rec.uid, frame);
          } else {
            const frame = parsePeerMessageFrame({ v: 1, kind: 'message', messageId: payload.id, clientMessageId: payload.id, senderId: rec.uid, text: payload.text, clientCreatedAt: payload.at });
            if (frame) this.ingest({ ...frame, transport: 'relay', conversationId: rec.uid, readAt: null }, rec.uid, rec.uid, this.nameOf(rec.uid));
          }
          if (id) via?.remove(await mailboxFor(this.identity.uid), id);
          // The relay path has no ack frame: confirm by sealed ack so the sender sees "delivered".
          void this.putTo(rec.uid, { t: 'ack', id: payload.id }, 'msg', 7 * 24 * 3600).catch(() => undefined);
          return;
        }
        case 'ack': {
          const m = typeof payload.id === 'string' ? this.msgs.get(payload.id) : undefined;
          if (m && m.senderId === this.identity.uid && m.recipients?.[rec.uid]) {
            this.setRecipient(m, rec.uid, 'DELIVERED');
            this.emit();
          }
          if (id) via?.remove(await mailboxFor(this.identity.uid), id);
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.notice(`Could not reach ${this.nameOf(rec.uid)}: ${errorMessage(error)}`);
    }
  }

  /* ---------------- the connection timer ---------------- */

  private connectingCount(): number {
    let n = 0;
    for (const l of this.links.values()) if (l.busy) n += 1;
    return n;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      let live = 0;
      for (const link of this.links.values()) if (link.ready) live += 1;
      for (const link of [...this.links.values()]) {
        if (link.ready) {
          if (now - (this.lastPing.get(link.uid) ?? 0) >= PING_MS) {
            this.lastPing.set(link.uid, now);
            link.beat(now);
          } else if (now - link.lastFrameAt > 14_000) {
            link.beat(now);
          }
          this.flush(link.uid);
          continue;
        }
        if (link.manual) continue;
        if (this.hub?.status() !== 'online') continue;
        if (link.state === 'connecting' && link.transport) continue;
        if (now - link.lastOfferAt < reconnectDelayMs(link.offerAttempt)) continue;
        if (live + this.connectingCount() >= SOFT_LINK_CAP) continue;
        if (link.isInitiator() && this.connectingCount() >= MAX_CONNECTING) continue;
        link.lastOfferAt = now;
        link.offerAttempt += 1;
        try {
          if (!link.isInitiator()) {
            await this.putTo(link.uid, { t: 'ready' }, 'sig', 120);
          } else {
            const sdp = await link.createOffer();
            await this.putTo(link.uid, { t: 'offer', sdp }, 'sig', 120);
          }
        } catch {
          if (link.transport && !link.ready) link.close();
        }
      }
      void this.maybeBluetooth();
      void this.relayPending();
      await this.retryPending();
      this.emit({ signaling: this.hub?.status() ?? 'idle' });
    } finally {
      this.ticking = false;
    }
  }

  /* ---------------- store-and-forward (off by default) ---------------- */

  private async relayPending(): Promise<void> {
    if (!this.network.storeForward || !this.hub || this.hub.status() !== 'online') return;
    for (const m of [...this.msgs.values()].sort(compareMessages)) {
      if (m.senderId !== this.identity.uid) continue;
      for (const [uid, state] of Object.entries(m.recipients ?? {})) {
        if (RANK[state] >= RANK.DELIVERED || this.links.get(uid)?.ready) continue;
        const key = `${m.messageId}|${uid}`;
        if (this.relayed.has(key)) continue;
        this.relayed.add(key);
        try {
          await this.putTo(uid, { t: 'msg', id: m.messageId, text: m.text, at: m.clientCreatedAt, ...(this.contacts.has(m.conversationId) ? {} : { g: m.conversationId }) }, 'msg', 7 * 24 * 3600);
          this.setRecipient(m, uid, 'SENT');
        } catch {
          this.relayed.delete(key);
        }
      }
    }
    this.emit();
  }

  /* ---------------- Bluetooth ---------------- */

  async bluetoothAvailable(): Promise<boolean> {
    if (this.bleBridge === undefined) this.bleBridge = await getBleBridge();
    return this.bleBridge !== null;
  }

  /** Search for one friend over Bluetooth (works with no internet, within radio range). */
  async connectBluetooth(uid: string): Promise<void> {
    const rec = this.contacts.get(uid);
    const link = this.links.get(uid);
    if (!rec || !link) throw new Error('Add your friend first.');
    if (link.ready || link.manual) return;
    if (!(await this.bluetoothAvailable()) || !this.bleBridge) throw new Error('Bluetooth is not available in this build or on this computer.');
    if (this.bleBusy) throw new Error('Already searching over Bluetooth.');
    this.bleBusy = true;
    const bridge = this.bleBridge;
    try {
      const secret = await ecdhAgree(this.identity.dhPrivateJwk, rec.card.dh);
      const ble = link.adoptBle(
        (handlers) =>
          new SecureBleLink(
            bridge,
            { ownUid: this.identity.uid, peerUid: uid, signPriv: this.identity.privateJwk, peerSign: rec.card.sign },
            handlers,
          ),
      );
      try {
        await ble.connect(secret);
      } catch (error) {
        link.close();
        throw error;
      }
    } finally {
      this.bleBusy = false;
    }
  }

  private async maybeBluetooth(): Promise<void> {
    if (!this.network.bluetooth || this.bleBusy || this.bleBridge === null) return;
    const now = Date.now();
    for (const link of this.links.values()) {
      if (link.ready || link.manual || link.state === 'connecting') continue;
      const next = this.bleNext.get(link.uid) ?? { at: 0, attempt: 0 };
      if (now < next.at) continue;
      this.bleNext.set(link.uid, { at: now + reconnectDelayMs(next.attempt, { baseMs: 15_000, maxMs: 120_000 }), attempt: next.attempt + 1 });
      try {
        await this.connectBluetooth(link.uid);
      } catch {
        // not in range / not available: the next attempt backs off further
      }
      return; // one search at a time
    }
  }

  /* ---------------- manual connection codes (Advanced) ---------------- */

  private manualLink(uid: string): PeerLink {
    const link = this.links.get(uid);
    if (!link) throw new Error('Add this friend first.');
    return link;
  }

  async createManualOffer(uid: string): Promise<string> {
    const link = this.manualLink(uid);
    link.manual = true;
    try {
      const sdp = await link.createOffer();
      return this.encodeManual('offer', sdp);
    } catch (error) {
      link.manual = false;
      throw error;
    }
  }

  async applyManualAnswer(code: string): Promise<void> {
    const decoded = decodeManualSignal(code, this.deps.context);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'answer') throw new Error('That is an offer. Paste it on your friend\'s device and send back the reply.');
    const link = await this.manualTarget(decoded.value);
    await link.applyAnswer(decoded.value.sdp);
  }

  async acceptManualOffer(code: string): Promise<string> {
    const decoded = decodeManualSignal(code, this.deps.context);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'offer') throw new Error('That is a reply. Paste the offer from your friend instead.');
    const link = await this.manualTarget(decoded.value);
    link.manual = true;
    try {
      return this.encodeManual('answer', await link.acceptOffer(decoded.value.sdp));
    } catch (error) {
      link.manual = false;
      throw error;
    }
  }

  private async manualTarget(signal: { fromUid: string; dhJwk: JsonWebKey; publicKeyJwk: JsonWebKey; identityProof: string }): Promise<PeerLink> {
    if (signal.fromUid === this.identity.uid) throw new Error('That code was made on this device.');
    if (!(await uidMatchesKeys(signal.fromUid, signal.dhJwk, signal.publicKeyJwk, signal.identityProof))) {
      throw new Error('That code is damaged: its identity does not match its key.');
    }
    const link = this.links.get(signal.fromUid);
    if (!link) throw new Error('That code is from someone who is not in your friends yet. Add them with their invite first.');
    return link;
  }

  private encodeManual(kind: 'offer' | 'answer', sdp: string): string {
    return encodeManualSignal(
      createManualSignal({
        kind,
        conversationId: this.deps.context,
        fromUid: this.identity.uid,
        fromDeviceId: this.identity.deviceId,
        publicKeyJwk: this.identity.publicJwk,
        dhJwk: this.identity.dhPublicJwk,
        identityProof: this.identity.identityProof,
        sdp,
        nonce: randomNonce(),
      }),
    );
  }

  cancelManual(): void {
    for (const link of this.links.values()) {
      if (link.manual) {
        link.manual = false;
        if (!link.ready) link.close();
      }
    }
  }

  /* ---------------- local data (kill switch + settings) ---------------- */

  async clearLocalData(): Promise<void> {
    await this.deps.store.clearAll();
    this.msgs.clear();
    this.pendingGroup.clear();
    this.relayed.clear();
    this.contacts.clear();
    this.known.clear();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    await this.coord.load({});
    this.emit({ notice: 'Everything on this device was cleared.' });
  }

  /** Erase every message, keep friends and groups. */
  async clearLocalChat(): Promise<void> {
    this.msgs.clear();
    this.pendingGroup.clear();
    this.relayed.clear();
    await this.deps.store.clearMessages();
    this.emit();
  }

  /** Forget every friend and group and close all connections (used by the emergency wipe). */
  eraseLocalChatSession(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.contacts.clear();
    this.known.clear();
    this.hub?.stop();
    this.hub = null;
    void this.coord.load({});
    this.emit({ notice: 'Friends and groups were erased from this device.' });
  }

  /* ---------------- view model ---------------- */

  private last(convId: string): LastMessage | undefined {
    let best: StoredMessage | undefined;
    for (const m of this.msgs.values()) if (m.conversationId === convId && (!best || compareMessages(best, m) < 0)) best = m;
    return best
      ? { text: best.text, at: best.clientCreatedAt, own: best.senderId === this.identity.uid, senderName: this.nameOf(best.senderId) }
      : undefined;
  }

  private unread(convId: string): number {
    let n = 0;
    for (const m of this.msgs.values()) if (m.conversationId === convId && m.senderId !== this.identity.uid && m.readAt == null) n += 1;
    return n;
  }

  private statusFor(uid: string): string {
    const link = this.links.get(uid);
    const name = this.nameOf(uid);
    if (link?.ready) return link.path ? `Connected · ${link.path.label}` : 'Connected';
    if (link?.state === 'connecting') return 'Connecting…';
    if (this.hub?.status() === 'online') return `Waiting for ${name} to come online`;
    return this.network.signaling.length === 0 ? 'Not connected · no connection service is set up' : 'Not connected';
  }

  private build(): ChatState {
    const me = this.identity.uid;
    const contacts: ContactView[] = [...this.contacts.values()].map((c) => {
      const link = this.links.get(c.uid);
      return {
        uid: c.uid,
        name: this.nameOf(c.uid),
        trust: c.trust,
        checked: c.checked,
        introducedBy: c.introducedBy,
        introducedByName: c.introducedBy ? this.nameOf(c.introducedBy) : undefined,
        conn: this.conn(c.uid),
        path: link?.path ?? null,
        via: link?.ready ? link.kind : null,
        unread: this.unread(c.uid),
        last: this.last(c.uid),
        status: this.statusFor(c.uid),
      };
    });
    const groups: GroupView[] = [];
    for (const groupId of this.coord.groupIds()) {
      const s = this.coord.state(groupId);
      if (!s) continue;
      const isMember = s.members.has(me);
      const members: MemberView[] = [...s.members.values()].map((m) => ({
        uid: m.uid,
        name: this.nameOf(m.uid),
        role: m.role,
        isMe: m.uid === me,
        addedBy: m.addedBy,
        addedByName: this.nameOf(m.addedBy),
        conn: m.uid === me ? 'connected' : this.conn(m.uid),
        introducedHere: !!this.contacts.get(m.uid)?.introducedBy && this.contacts.get(m.uid)?.introducedBy === m.addedBy,
      }));
      groups.push({
        groupId,
        name: s.name,
        status: isMember ? 'member' : (this.groupNotes.get(groupId) ?? 'removed'),
        members,
        amAdmin: s.members.get(me)?.role === 'admin',
        connected: members.filter((m) => !m.isMe && m.conn === 'connected').length,
        unread: this.unread(groupId),
        last: this.last(groupId),
      });
    }
    const messages: Record<string, UiMessage[]> = {};
    let queued = 0;
    for (const m of [...this.msgs.values()].sort(compareMessages)) {
      const own = m.senderId === me;
      const states = Object.values(m.recipients ?? {});
      if (own) queued += states.filter((s) => RANK[s] < RANK.DELIVERED).length;
      (messages[m.conversationId] ??= []).push({
        ...m,
        own,
        senderName: this.nameOf(m.senderId),
        tick: own ? aggregate(m.recipients) : m.deliveryState,
        delivered: states.filter((s) => RANK[s] >= RANK.DELIVERED).length,
        total: states.length,
      });
    }
    return { ...this.state, contacts, groups, messages, queued, storageBackend: this.deps.store.backend, signaling: this.hub?.status() ?? 'idle' };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}

/** `decodeContactCard` is async only for the proof check; our own card is known-good, so read it directly. */
function decodeCardSync(text: string): ContactCard {
  const json = atob(text.slice('DUOID1:'.length).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil((text.length - 7) / 4) * 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as ContactCard;
}
