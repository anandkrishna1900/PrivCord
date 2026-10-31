import {
  CHANNEL_TTL_SEC,
  diagnoseConnection,
  type Diagnosis,
  deleteFrame,
  parseDeleteFrame,
  parseReactFrame,
  reactFrame,
  summarizeReactions,
  BACKUP_MIN_PASSPHRASE,
  openBackup,
  sealBackup,
  FileAssembler,
  MAX_CHANNEL_TEXT,
  deriveChannel,
  normalizeChannelName,
  openChannelMessage,
  sealChannelMessage,
  type ChannelKeys,
  INVITE_TTL_SEC,
  deriveInvite,
  encodeContactCard,
  newInviteWords,
  openInvite,
  parseInviteWords,
  sealInvite,
  type InviteRendezvous,
  acceptsDirect as acceptsDirectFrom,
  canStartDirect,
  GroupCoordinator,
  MAX_FILE_BYTES,
  MAX_GROUP_MEMBERS,
  compareMessages,
  createManualSignal,
  createOutgoingMessage,
  createPeerMessageFrame,
  decodeContactCard,
  decodeManualSignal,
  deriveSafetyNumber,
  ecdhAgree,
  encodeManualSignal,
  fileChunks,
  filePreviewText,
  isRecord,
  mailboxFor,
  makeFileOffer,
  makeReplyRef,
  open as openBlob,
  parseDeclinedFrame,
  parseFileChunk,
  parseFileOffer,
  parseGroupFrame,
  parsePeerFrame,
  parsePeerMessageFrame,
  randomNonce,
  reconnectDelayMs,
  sanitizeFileName,
  sanitizeMime,
  seal,
  validateFileSize,
  type ConnectionPath,
  type Contact,
  type ContactCard,
  type DeliveryState,
  type GroupFrame,
  type GroupResult,
  type FileOfferFrame,
  type NetworkConfig,
  type ReplyRef,
  type SealedBlob,
} from '@duochat/protocol';
import {
  contactCardOf,
  loadPairing,
  uidMatchesKeys,
  type DeviceIdentity,
} from './identity';
import { loadNetworkConfig, rtcConfigFor, saveNetworkConfig } from './network';
import { SignalingHub, transportsFor } from './signaling/hub';
import type { SignalingStatus, SignalingTransport } from './signaling/types';
import { LocalStore, type FileMeta, type StoredMessage } from './localDb';
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
  /** Why it is not connecting, in plain words, once it has been tried a few times. */
  diagnosis?: Diagnosis;
  /** Appears in the chat list and can be messaged. Group-only people do not until verified. */
  direct: boolean;
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
  /** Direct messages are possible with this person (you exchanged invites or verified them). */
  canMessage: boolean;
}

export interface GroupView {
  groupId: string;
  name: string;
  /** `member`: active. `removed` / `left`: read-only. */
  status: 'member' | 'removed' | 'left';
  members: MemberView[];
  amAdmin: boolean;
  /** The group has reached the hard member limit. */
  full: boolean;
  maxMembers: number;
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
  /** 0..1 while a file is being sent or received. */
  progress?: number;
  /** Reactions grouped for display. */
  reactionChips: { emoji: string; count: number; mine: boolean }[];
}

export interface SearchHit {
  messageId: string;
  convId: string;
  convName: string;
  senderName: string;
  text: string;
  at: number;
}

/** Someone who used our invite words and answered with their own card. */
export interface InviteRequest {
  uid: string;
  name: string;
  safetyNumber: string;
}

/** A public channel we have joined. */
export interface ChannelView {
  /** Conversation id: `chan:` plus the normalized name. */
  id: string;
  name: string;
  unread: number;
  last?: LastMessage;
  conn: ConnState;
}

/** After typing a friend's words: did our own invite reach them? (They then confirm us on their side.) */
export interface InviteAnswer {
  uid: string;
  name: string;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
}

export interface ChatState {
  channels: ChannelView[];
  answer: InviteAnswer | null;
  /** Our current six-word invite, if one is being shown. */
  invite: { words: string; expiresAt: number } | null;
  /** People who used our words and are waiting for us to accept them. */
  requests: InviteRequest[];
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
const MAX_CHANNELS = 8;
const STALL_MS = 30_000;
const PROGRESS_EVERY = 8;
const RANK: Record<DeliveryState, number> = { QUEUED: 0, FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const WEAKNESS = (s: DeliveryState): number => (s === 'FAILED' ? -1 : RANK[s]);
const maxState = (a: DeliveryState, b: DeliveryState): DeliveryState => (RANK[b] > RANK[a] ? b : a);
const short = (uid: string) => uid.slice(0, 6);

function aggregate(recipients: Record<string, DeliveryState> | undefined): DeliveryState {
  const values = Object.values(recipients ?? {});
  if (values.length === 0) return 'SENT';
  return values.reduce((weakest, s) => (WEAKNESS(s) < WEAKNESS(weakest) ? s : weakest));
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
  /** Privacy setting: people we only know through a group stay group-only for us. */
  private groupOnly = loadSettings().groupOnly;
  /** What each connected friend told us about their own setting (re-announced on every link). */
  private peerGroupOnly = new Map<string, boolean>();
  private activeInvite: { words: string[]; rv: InviteRendezvous; hub: SignalingHub; expiresAt: number; timer: ReturnType<typeof setTimeout>; republish: ReturnType<typeof setInterval> } | null = null;
  private requestCards = new Map<string, { contact: Contact; safetyNumber: string }>();
  private redeemed: { words: string; rv: InviteRendezvous; contact: Contact } | null = null;
  private channels = new Map<string, { keys: ChannelKeys; hub: SignalingHub }>();
  private blocked = new Set<string>();
  private assemblers = new Map<string, FileAssembler>();
  private lastChunkAt = new Map<string, number>();
  private sendingFiles = new Set<string>();
  private progress = new Map<string, number>();

  constructor(private readonly deps: EngineDeps) {
    this.identity = deps.identity;
    this.coord = this.newCoordinator();
    this.state = {
      channels: [],
      answer: null,
      invite: null,
      requests: [],
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
      for (const uid of (await this.deps.store.getSecret<string[]>('blocked')) ?? []) this.blocked.add(uid);
      const stored = await this.deps.store.loadMessages();
      for (const m of stored) this.msgs.set(m.messageId, m);
      await this.migrateLegacy();
      if (this.stopped) return;
      this.startSignaling();
      for (const name of (await this.deps.store.getSecret<string[]>('channels')) ?? []) await this.joinChannel(name, false).catch(() => undefined);
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
    this.stopInvite();
    for (const c of this.channels.values()) c.hub.stop();
    this.channels.clear();
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
    const words = parseInviteWords(text);
    const contact = words ? await this.lookUpInvite(words) : await decodeContactCard(text);
    if (!contact) throw new Error('That does not look like a PrivCord invite. Check the words, or ask your friend to share it again.');
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
    const words = parseInviteWords(text);
    let answerWith: InviteRendezvous | null = null;
    let contact: Contact | null;
    if (words) {
      if (!this.redeemed || this.redeemed.words !== words.join(' ')) this.redeemed = null;
      contact = this.redeemed?.contact ?? (await this.lookUpInvite(words));
      answerWith = this.redeemed?.rv ?? null;
    } else {
      contact = await decodeContactCard(text);
    }
    if (!contact) throw new Error('That does not look like a PrivCord invite. Check the words, or ask your friend to share it again.');
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
    // Used someone's words: answer with our own card so they can accept us (they confirm it on their side).
    if (answerWith) {
      this.lastAnswer = { rv: answerWith, uid: contact.uid };
      void this.runAnswer();
    }
    this.redeemed = null;
    return contact.uid;
  }

  private lastAnswer: { rv: InviteRendezvous; uid: string } | null = null;

  /** Sends our invite back and keeps the result where the screen can show it. */
  private async runAnswer(): Promise<void> {
    const last = this.lastAnswer;
    if (!last) return;
    const name = this.nameOf(last.uid);
    this.emit({ answer: { uid: last.uid, name, status: 'sending' } });
    try {
      await this.answerInvite(last.rv);
      this.emit({ answer: { uid: last.uid, name, status: 'sent' } });
    } catch (error) {
      this.emit({ answer: { uid: last.uid, name, status: 'failed', error: errorMessage(error) } });
    }
  }

  retryAnswer(): void {
    void this.runAnswer();
  }

  clearAnswer(): void {
    this.emit({ answer: null });
  }

  /* ---------------- delete, reactions, search ---------------- */

  private dropMessage(messageId: string): void {
    this.msgs.delete(messageId);
    void this.deps.store.deleteMessage(messageId).catch(() => undefined);
  }

  /** "Delete for me" removes it here only. "Delete for everyone" (your own messages) also asks the others to remove it. */
  deleteMessage(messageId: string, everyone: boolean): void {
    const m = this.msgs.get(messageId);
    if (!m) return;
    if (!everyone || m.senderId !== this.identity.uid) {
      this.dropMessage(messageId);
      this.emit();
      return;
    }
    this.tombstone(m);
    for (const uid of this.recipientsOfConversation(m.conversationId)) {
      const link = this.links.get(uid);
      if (link?.ready && link.sendJson(deleteFrame(messageId))) link.sent.add(`del:${messageId}`);
    }
    this.emit();
  }

  private tombstone(m: StoredMessage): void {
    m.deleted = true;
    m.text = '';
    m.file = undefined;
    m.type = 'text';
    m.reactions = undefined;
    m.replyTo = undefined;
    void this.deps.store.deleteFile(m.messageId).catch(() => undefined);
    void this.deps.store.putMessage(m).catch(() => undefined);
  }

  private applyRemoteDelete(from: string, messageId: string): void {
    const m = this.msgs.get(messageId);
    // Only the author can delete a message for everyone.
    if (!m || m.senderId !== from || m.deleted) return;
    this.tombstone(m);
    this.emit();
  }

  /** Toggle my reaction on a message (the same emoji again removes it). */
  react(messageId: string, emoji: string): void {
    const m = this.msgs.get(messageId);
    if (!m || m.deleted || m.conversationId.startsWith('chan:')) return;
    const me = this.identity.uid;
    const reactions = { ...(m.reactions ?? {}) };
    const on = reactions[me] !== emoji;
    if (on) reactions[me] = emoji;
    else delete reactions[me];
    m.reactions = reactions;
    void this.deps.store.putMessage(m).catch(() => undefined);
    for (const uid of this.recipientsOfConversationAll(m)) {
      const link = this.links.get(uid);
      if (link?.ready && link.sendJson(reactFrame(messageId, emoji, on))) link.sent.add(`rx:${messageId}:${emoji}`);
    }
    this.emit();
  }

  /** Everyone in a message's conversation except me (for a message someone else sent this includes the sender). */
  private recipientsOfConversationAll(m: StoredMessage): string[] {
    const me = this.identity.uid;
    if (this.contacts.has(m.conversationId)) return [m.conversationId];
    return (this.coord.state(m.conversationId) ? [...this.coord.state(m.conversationId)!.members.keys()] : []).filter((u) => u !== me);
  }

  private applyRemoteReaction(from: string, messageId: string, emoji: string, on: boolean): void {
    const m = this.msgs.get(messageId);
    if (!m || m.deleted) return;
    const inConversation = this.contacts.has(m.conversationId) ? m.conversationId === from : this.coord.isMember(m.conversationId, from);
    if (!inConversation) return;
    const reactions = { ...(m.reactions ?? {}) };
    if (on) reactions[from] = emoji;
    else if (reactions[from] === emoji) delete reactions[from];
    m.reactions = reactions;
    void this.deps.store.putMessage(m).catch(() => undefined);
    this.emit();
  }

  /** Looks through the messages on this device (nothing leaves it). */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const nameOfConv = (id: string) => (id.startsWith('chan:') ? `# ${id.slice(5)}` : this.contacts.has(id) ? this.nameOf(id) : (this.coord.state(id)?.name ?? 'Chat'));
    return [...this.msgs.values()]
      .filter((m) => !m.deleted && m.text.toLowerCase().includes(q) && !(m.senderId !== this.identity.uid && this.blocked.has(m.senderId)))
      .sort((a, b) => b.clientCreatedAt - a.clientCreatedAt)
      .slice(0, limit)
      .map((m) => ({
        messageId: m.messageId,
        convId: m.conversationId,
        convName: nameOfConv(m.conversationId),
        senderName: m.senderId === this.identity.uid ? 'You' : (m.senderName ?? this.nameOf(m.senderId)),
        text: m.text,
        at: m.clientCreatedAt,
      }));
  }

  /* ---------------- backup ---------------- */

  /** A passphrase-protected copy of friends, groups, channels and messages (no files, no recovery phrase). */
  async exportBackup(passphrase: string): Promise<string> {
    if (passphrase.length < BACKUP_MIN_PASSPHRASE) throw new Error(`Use at least ${BACKUP_MIN_PASSPHRASE} characters.`);
    const messages = [...this.msgs.values()].map((m) => ({ ...m, file: m.file ? { ...m.file } : undefined }));
    return sealBackup(
      {
        v: 1,
        uid: this.identity.uid,
        at: Date.now(),
        contacts: [...this.contacts.values()],
        groups: this.coord.export(),
        channels: [...this.channels.keys()],
        blocked: [...this.blocked],
        messages,
      },
      passphrase,
    );
  }

  /** Adds what is in a backup to what is here. Never replaces or removes anything that already exists. */
  async importBackup(text: string, passphrase: string): Promise<{ friends: number; groups: number; messages: number }> {
    const data = (await openBackup(text, passphrase)) as {
      v?: number; uid?: string; contacts?: ContactRecord[]; groups?: Record<string, unknown[]>; channels?: string[];
      blocked?: string[]; messages?: StoredMessage[];
    } | null;
    if (!data || data.v !== 1 || typeof data.uid !== 'string') throw new Error('That did not open. Check the passphrase and that this is a PrivCord backup file.');
    if (data.uid !== this.identity.uid) throw new Error('This backup belongs to a different identity. Restore your 12-word recovery phrase first, then import it.');
    let friends = 0;
    for (const rec of data.contacts ?? []) {
      if (!rec?.uid || !rec.card || this.contacts.has(rec.uid)) continue;
      this.registerContact(rec, false);
      friends += 1;
    }
    if (friends > 0) this.persistContacts();
    let groups = 0;
    const missing = Object.fromEntries(Object.entries(data.groups ?? {}).filter(([id]) => !this.coord.groupIds().includes(id)));
    if (Object.keys(missing).length > 0) {
      await this.coord.load(missing);
      groups = Object.keys(missing).length;
      this.persistGroups();
    }
    let added = 0;
    for (const m of data.messages ?? []) {
      if (!m?.messageId || this.msgs.has(m.messageId)) continue;
      this.msgs.set(m.messageId, m);
      await this.deps.store.putMessage(m).catch(() => undefined);
      added += 1;
    }
    for (const uid of data.blocked ?? []) this.blocked.add(uid);
    for (const name of data.channels ?? []) await this.joinChannel(name, true).catch(() => undefined);
    this.emit({ notice: `Restored ${friends} friend${friends === 1 ? '' : 's'}, ${groups} group${groups === 1 ? '' : 's'} and ${added} message${added === 1 ? '' : 's'}.` });
    void this.tick();
    return { friends, groups, messages: added };
  }

  /* ---------------- open channels ---------------- */

  /** A readable name for someone we only know from a channel: their chosen name plus a short id. */
  private channelLabel(card: ContactCard, uid: string): string {
    return `${card.name?.trim() || 'Anonymous'} #${uid.slice(0, 4)}`;
  }

  /** Join (or create: there is no difference) a public channel. Returns its conversation id. */
  async joinChannel(raw: string, persist = true): Promise<string> {
    const name = normalizeChannelName(raw);
    if (!name) throw new Error('Type a channel name, for example general.');
    if (this.channels.has(name)) return `chan:${name}`;
    if (this.channels.size >= MAX_CHANNELS) throw new Error(`You can be in at most ${MAX_CHANNELS} channels. Leave one first.`);
    const hub = await this.onlineHub();
    const keys = await deriveChannel(name);
    hub.start(keys.mailbox, (blob) => void this.onChannelBlob(keys, blob));
    this.channels.set(name, { keys, hub });
    if (persist) this.persistChannels();
    this.emit();
    return `chan:${name}`;
  }

  leaveChannel(convId: string): void {
    const name = convId.replace(/^chan:/, '');
    this.channels.get(name)?.hub.stop();
    this.channels.delete(name);
    for (const [id, m] of [...this.msgs]) if (m.conversationId === `chan:${name}`) this.msgs.delete(id);
    this.persistChannels();
    this.emit();
  }

  private persistChannels(): void {
    void this.deps.store.setSecret('channels', [...this.channels.keys()]).catch(() => undefined);
  }

  /** Stop showing a person's channel messages (kept on this device only). */
  muteSender(uid: string): void {
    this.blocked.add(uid);
    void this.deps.store.setSecret('blocked', [...this.blocked]).catch(() => undefined);
    this.emit();
  }

  unmuteSender(uid: string): void {
    this.blocked.delete(uid);
    void this.deps.store.setSecret('blocked', [...this.blocked]).catch(() => undefined);
    this.emit();
  }

  private async sendChannel(name: string, rawText: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const c = this.channels.get(name);
    if (!c) return { ok: false, error: 'You left this channel.' };
    const text = rawText.replace(/\r\n?/g, '\n').trim();
    if (!text) return { ok: false, error: 'Message cannot be empty.' };
    if (Array.from(text).length > MAX_CHANNEL_TEXT) return { ok: false, error: `Channel messages are limited to ${MAX_CHANNEL_TEXT} characters.` };
    if (c.hub.status() !== 'online') return { ok: false, error: 'Not connected to the connection service yet. Try again in a moment.' };
    const at = Date.now();
    const blob = await sealChannelMessage({ channel: c.keys, text, at, card: this.ownCard(), uid: this.identity.uid, signPriv: this.identity.privateJwk });
    await this.publishChannel(c, blob);
    this.storeChannelMessage(name, `c-${blob.sig.slice(0, 24)}`, this.identity.uid, text, at, this.channelLabel(this.ownCard(), this.identity.uid));
    return { ok: true };
  }

  /** Live copy always; a stored copy (history for people who join later) only if store-and-forward is on. */
  private async publishChannel(c: { keys: ChannelKeys; hub: SignalingHub }, blob: SealedBlob): Promise<void> {
    const results = await Promise.allSettled([
      c.hub.put(c.keys.mailbox, blob, { kind: 'sig', ttlSec: 120 }),
      ...(this.network.storeForward ? [c.hub.put(c.keys.mailbox, blob, { kind: 'msg', ttlSec: CHANNEL_TTL_SEC })] : []),
    ]);
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('Could not send. Check your connection.');
  }

  private storeChannelMessage(name: string, messageId: string, senderId: string, text: string, at: number, senderName: string): void {
    if (this.msgs.has(messageId)) return;
    const convId = `chan:${name}`;
    const own = senderId === this.identity.uid;
    const m: StoredMessage = {
      messageId,
      clientMessageId: messageId,
      senderId,
      text,
      clientCreatedAt: Math.min(at, Date.now() + 5 * 60_000),
      type: 'text',
      transport: 'p2p',
      deliveryState: own ? 'SENT' : 'DELIVERED',
      readAt: own || (this.active === convId && this.visible) ? Date.now() : null,
      conversationId: convId,
      senderName,
    };
    this.msgs.set(messageId, m);
    void this.deps.store.putMessage(m).catch(() => undefined);
    this.emit();
  }

  private async onChannelBlob(keys: ChannelKeys, blob: SealedBlob): Promise<void> {
    const message = await openChannelMessage(keys, blob);
    if (!message) return;
    const { contact } = message;
    if (contact.uid === this.identity.uid || this.blocked.has(contact.uid)) return;
    this.storeChannelMessage(keys.name, `c-${blob.sig.slice(0, 24)}`, contact.uid, message.text, message.at, this.channelLabel(contact.card, contact.uid));
  }

  /* ---------------- six-word invites ---------------- */

  private async onlineHub(): Promise<SignalingHub> {
    if (this.network.signaling.length === 0) {
      throw new Error('Six-word invites need a connection service (Settings > Connection). The QR code and the full invite text work without one.');
    }
    const hub = new SignalingHub(transportsFor(this.network));
    return hub;
  }

  /**
   * A live copy always (it is re-sent every few seconds while the invite is open). A stored copy only when the
   * user turned store-and-forward on: with it off, nothing may be kept on a relay.
   */
  private async putEverywhere(hub: SignalingHub, mailbox: string, blob: SealedBlob): Promise<void> {
    const results = await Promise.allSettled([
      hub.put(mailbox, blob, { kind: 'sig', ttlSec: 120 }),
      ...(this.network.storeForward ? [hub.put(mailbox, blob, { kind: 'msg', ttlSec: INVITE_TTL_SEC })] : []),
    ]);
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('Could not publish the invite.');
  }

  private async waitOnline(hub: SignalingHub, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (hub.status() !== 'online') {
      if (Date.now() > end) {
        hub.stop();
        throw new Error('Could not reach the connection service. Check your internet and try again.');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Show-your-words: publish our card under fresh words and listen for people who answer. */
  async createInvite(): Promise<{ words: string; expiresAt: number }> {
    if (this.activeInvite && this.activeInvite.expiresAt > Date.now() + 30_000) {
      return { words: this.activeInvite.words.join(' '), expiresAt: this.activeInvite.expiresAt };
    }
    this.stopInvite();
    const hub = await this.onlineHub();
    const words = newInviteWords();
    const rv = await deriveInvite(words);
    hub.start(rv.mailbox, (blob) => void this.onInviteBlob(rv, blob));
    await this.waitOnline(hub);
    const publish = async () => {
      const blob = await sealInvite({ rendezvous: rv, kind: 'card', card: this.ownCard(), uid: this.identity.uid, signPriv: this.identity.privateJwk });
      await this.putEverywhere(hub, rv.mailbox, blob);
    };
    await publish();
    const expiresAt = Date.now() + INVITE_TTL_SEC * 1000;
    const timer = setTimeout(() => this.stopInvite(), INVITE_TTL_SEC * 1000);
    // Relays differ in what they keep (some store nothing, Nostr drops live-only events), so the card is
    // published again every few seconds as well as stored once: whoever types the words next finds it.
    const republish = setInterval(() => void publish().catch(() => undefined), 8_000);
    this.activeInvite = { words, rv, hub, expiresAt, timer, republish };
    this.emit({ invite: { words: words.join(' '), expiresAt } });
    return { words: words.join(' '), expiresAt };
  }

  private stopInvite(): void {
    if (!this.activeInvite) return;
    clearTimeout(this.activeInvite.timer);
    clearInterval(this.activeInvite.republish);
    this.activeInvite.hub.stop();
    this.activeInvite = null;
    this.emit({ invite: null });
  }

  private async onInviteBlob(rv: InviteRendezvous, blob: SealedBlob): Promise<void> {
    const message = await openInvite(rv, blob);
    if (!message || message.kind !== 'reply') return;
    const { contact } = message;
    if (contact.uid === this.identity.uid || this.contacts.get(contact.uid)?.trust === 'verified') return;
    this.requestCards.set(contact.uid, {
      contact,
      safetyNumber: await deriveSafetyNumber(this.identity.publicJwk, contact.card.sign),
    });
    this.emit();
  }

  /** Accept somebody who used our words. */
  async acceptRequest(uid: string): Promise<string> {
    const r = this.requestCards.get(uid);
    if (!r) throw new Error('That request is no longer there.');
    this.requestCards.delete(uid);
    return this.addContact(encodeContactCard(r.contact.card));
  }

  dismissRequest(uid: string): void {
    this.requestCards.delete(uid);
    this.emit();
  }

  /** Enter-their-words: fetch their card from the meeting point. Null if nobody answered in time. */
  private async lookUpInvite(words: string[]): Promise<Contact | null> {
    const rv = await deriveInvite(words);
    const hub = await this.onlineHub();
    const found = await new Promise<Contact | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      hub.start(rv.mailbox, (blob) => {
        void openInvite(rv, blob).then((m) => {
          if (m?.kind === 'card') {
            clearTimeout(timer);
            resolve(m.contact);
          }
        });
      });
    });
    hub.stop();
    if (!found) throw new Error('Could not find that invite. Check the words, make sure your friend still has the invite open, and that you are both online.');
    this.redeemed = { words: words.join(' '), rv, contact: found };
    return found;
  }

  private async answerInvite(rv: InviteRendezvous): Promise<void> {
    const hub = await this.onlineHub();
    hub.start(rv.mailbox, () => undefined);
    try {
      await this.waitOnline(hub);
      const blob = await sealInvite({ rendezvous: rv, kind: 'reply', card: this.ownCard(), uid: this.identity.uid, signPriv: this.identity.privateJwk });
      await this.putEverywhere(hub, rv.mailbox, blob);
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      hub.stop();
    }
  }

  /**
   * The user compared the safety numbers (a check, not a pairing: direct messages follow the group-only
   * rules, and swapping invites is what pairs two people for good).
   */
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
      onClosed: (link: PeerLink) => {
        this.assemblers.get(link.uid)?.clear();
        for (const key of [...this.sendingFiles]) if (key.startsWith(`${link.uid}|`)) this.sendingFiles.delete(key);
        this.emit();
      },
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
    link.heardAt = 0;
    link.sendJson({ v: 1, kind: 'privacy', groupOnly: this.groupOnly });
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

  /**
   * Can we start or continue a direct chat with this person? Always for friends we exchanged invites with.
   * For people we only met through a group: unless we or they chose to stay group-only.
   */
  private canDirect(uid: string): boolean {
    const rec = this.contacts.get(uid);
    if (!rec) return false;
    return canStartDirect(rec.trust, this.groupOnly, this.peerGroupOnly.get(uid));
  }

  /** Do we accept a direct message from them? Their setting does not matter here, ours does. */
  private acceptsDirect(uid: string): boolean {
    const rec = this.contacts.get(uid);
    return !!rec && acceptsDirectFrom(rec.trust, this.groupOnly);
  }

  /** Turn our group-only privacy setting on or off and tell everyone we are connected to. */
  setGroupOnly(value: boolean): void {
    this.groupOnly = value;
    for (const link of this.links.values()) link.sendJson({ v: 1, kind: 'privacy', groupOnly: value });
    this.emit();
  }

  /** Why this conversation cannot be written to right now, or null if it can. */
  private cannotWrite(convId: string): string | null {
    const rec = this.contacts.get(convId);
    if (rec) {
      if (this.canDirect(convId)) return null;
      const who = this.nameOf(convId);
      return this.groupOnly
        ? `You stay group-only with people you meet in groups. To message ${who} directly, swap invites (Add friend).`
        : `${who} stays group-only, so you can talk in your groups but not directly. To message them, swap invites (Add friend).`;
    }
    if (convId.startsWith('chan:')) return this.channels.has(convId.slice(5)) ? null : 'You left this channel.';
    const s = this.coord.state(convId);
    if (!s) return 'Unknown chat.';
    return s.members.has(this.identity.uid) ? null : 'You are not in this group any more.';
  }

  /** The quote that goes with a reply, taken from our own copy of the message. */
  private replyFor(convId: string, replyToId: string | undefined): ReplyRef | undefined {
    if (!replyToId) return undefined;
    const original = this.msgs.get(replyToId);
    if (!original || original.conversationId !== convId) return undefined;
    return makeReplyRef(original);
  }

  async send(convId: string, rawText: string, replyToId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const blocked = this.cannotWrite(convId);
      if (blocked) return { ok: false, error: blocked };
      if (convId.startsWith('chan:')) return await this.sendChannel(convId.slice(5), rawText);
      const base = {
        ...createOutgoingMessage({ senderId: this.identity.uid, text: rawText, replyTo: this.replyFor(convId, replyToId) }),
      };
      const recipients: Record<string, DeliveryState> = {};
      for (const uid of this.recipientsOfConversation(convId)) recipients[uid] = 'QUEUED';
      const message: StoredMessage = {
        ...base,
        conversationId: convId,
        recipients,
        deliveryState: Object.keys(recipients).length ? 'QUEUED' : 'SENT',
      };
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

  /** Send a file (at most 8 MB) to a friend or a group. It goes straight to each person over the direct link. */
  async sendFile(
    convId: string,
    file: { name: string; mime: string; bytes: Uint8Array },
    replyToId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const blocked = this.cannotWrite(convId);
      if (blocked) return { ok: false, error: blocked };
      const tooBig = validateFileSize(file.bytes.length);
      if (tooBig) return { ok: false, error: tooBig };
      const name = sanitizeFileName(file.name);
      const isGroup = !this.contacts.has(convId);
      const messageId = crypto.randomUUID();
      const recipients: Record<string, DeliveryState> = {};
      for (const uid of this.recipientsOfConversation(convId)) recipients[uid] = 'QUEUED';
      const offer = await makeFileOffer({
        messageId,
        groupId: isGroup ? convId : undefined,
        name,
        mime: file.mime,
        bytes: file.bytes,
        clientCreatedAt: Date.now(),
        replyTo: this.replyFor(convId, replyToId),
      });
      await this.deps.store.putFile(messageId, file.bytes);
      const message: StoredMessage = {
        messageId,
        clientMessageId: messageId,
        senderId: this.identity.uid,
        text: name,
        clientCreatedAt: offer.clientCreatedAt,
        type: 'file',
        transport: 'p2p',
        deliveryState: Object.keys(recipients).length ? 'QUEUED' : 'SENT',
        readAt: null,
        conversationId: convId,
        recipients,
        file: { name, mime: offer.mime, size: offer.size, sha256: offer.sha256 },
        ...(offer.replyTo ? { replyTo: offer.replyTo } : {}),
      };
      this.msgs.set(messageId, message);
      await this.deps.store.putMessage(message);
      for (const uid of Object.keys(recipients)) this.deliver(message, uid);
      this.emit();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** The bytes of a stored file, for showing or saving it. */
  async getFile(messageId: string): Promise<{ blob: Blob; meta: FileMeta } | null> {
    const m = this.msgs.get(messageId);
    if (!m?.file) return null;
    const bytes = await this.deps.store.getFile(messageId);
    if (!bytes) return null;
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: m.file.mime }), meta: m.file };
  }

  async retry(messageId: string): Promise<void> {
    const m = this.msgs.get(messageId);
    if (!m || m.senderId !== this.identity.uid) return;
    for (const uid of Object.keys(m.recipients ?? {})) {
      // A refused message (FAILED) is tried again from the start.
      if (m.recipients?.[uid] === 'FAILED') this.setRecipient(m, uid, 'QUEUED', true);
      this.links.get(uid)?.sent.delete(messageId);
      this.deliver(m, uid);
    }
    this.emit();
  }

  private frameFor(m: StoredMessage): unknown {
    if (this.contacts.has(m.conversationId)) return createPeerMessageFrame(m);
    return {
      v: 1,
      kind: 'gmsg',
      groupId: m.conversationId,
      messageId: m.messageId,
      text: m.text,
      clientCreatedAt: m.clientCreatedAt,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    };
  }

  /** Write one message to one recipient if their channel is up. */
  private deliver(m: StoredMessage, uid: string): void {
    const state = m.recipients?.[uid];
    if (m.deleted || !state || state === 'FAILED' || RANK[state] >= RANK.DELIVERED) return;
    const link = this.links.get(uid);
    if (!link?.ready || link.sent.has(m.messageId)) return;
    if (m.type === 'file') {
      void this.pushFile(link, m);
      return;
    }
    if (!link.sendJson(this.frameFor(m))) return;
    link.sent.add(m.messageId);
    this.setRecipient(m, uid, 'SENT');
  }

  /** Stream one file to one recipient: offer, then ordered chunks, pausing while the channel is backed up. */
  private async pushFile(link: PeerLink, m: StoredMessage): Promise<void> {
    const key = `${link.uid}|${m.messageId}`;
    if (this.sendingFiles.has(key)) return;
    if (link.kind !== 'webrtc') return; // too slow over Bluetooth: it waits for an internet link
    this.sendingFiles.add(key);
    try {
      const bytes = await this.deps.store.getFile(m.messageId);
      if (!bytes || !m.file) {
        this.failRecipient(m, link.uid, 'This file is no longer stored on this device.');
        return;
      }
      const offer: FileOfferFrame = {
        v: 1,
        kind: 'file_offer',
        messageId: m.messageId,
        ...(this.contacts.has(m.conversationId) ? {} : { groupId: m.conversationId }),
        name: m.file.name,
        mime: m.file.mime,
        size: m.file.size,
        sha256: m.file.sha256,
        clientCreatedAt: m.clientCreatedAt,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        };
      if (!link.sendJson(offer)) return;
      let sentChunks = 0;
      const total = Math.ceil(bytes.length / 12288);
      for (const chunk of fileChunks(m.messageId, bytes)) {
        if (!link.ready || !(await link.waitWritable())) return; // link dropped: the next link opening starts over
        if (!link.sendJson(chunk)) return;
        sentChunks += 1;
        if (sentChunks % PROGRESS_EVERY === 0) {
          this.progress.set(m.messageId, sentChunks / total);
          this.emit();
        }
      }
      link.sent.add(m.messageId);
      this.setRecipient(m, link.uid, 'SENT');
    } catch {
      // The channel failed mid-way; flush() starts the transfer again when the link is back.
    } finally {
      this.sendingFiles.delete(key);
      this.progress.delete(m.messageId);
      this.emit();
    }
  }

  private failRecipient(m: StoredMessage, uid: string, why: string): void {
    const recipients = { ...(m.recipients ?? {}), [uid]: 'FAILED' as DeliveryState };
    m.recipients = recipients;
    m.deliveryState = aggregate(recipients);
    void this.deps.store.updateMessage(m.messageId, { recipients, deliveryState: m.deliveryState }).catch(() => undefined);
    this.notice(why);
  }

  private setRecipient(m: StoredMessage, uid: string, state: DeliveryState, force = false): void {
    const recipients = { ...(m.recipients ?? {}) };
    recipients[uid] = force ? state : maxState(recipients[uid] ?? 'QUEUED', state);
    m.recipients = recipients;
    m.deliveryState = aggregate(recipients);
    void this.deps.store.updateMessage(m.messageId, { recipients, deliveryState: m.deliveryState }).catch(() => undefined);
  }

  /** Everything still owed to this contact, oldest first. */
  private flush(uid: string): void {
    const own = [...this.msgs.values()]
      .filter((m) => m.senderId === this.identity.uid && m.recipients?.[uid] && m.recipients[uid] !== 'FAILED' && RANK[m.recipients[uid]!] < RANK.DELIVERED)
      .sort(compareMessages);
    for (const m of own) this.deliver(m, uid);
    const link = this.links.get(uid);
    if (link?.ready) {
      for (const m of this.msgs.values()) {
        const inConv = m.conversationId === uid || (m.recipients && uid in m.recipients);
        if (!inConv) continue;
        if (m.deleted && m.senderId === this.identity.uid && !link.sent.has(`del:${m.messageId}`)) {
          if (link.sendJson(deleteFrame(m.messageId))) link.sent.add(`del:${m.messageId}`);
        }
        const mine = m.reactions?.[this.identity.uid];
        if (mine && !m.deleted && !link.sent.has(`rx:${m.messageId}:${mine}`)) {
          if (link.sendJson(reactFrame(m.messageId, mine, true))) link.sent.add(`rx:${m.messageId}:${mine}`);
        }
      }
    }
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
    if (isRecord(raw) && raw.kind === 'privacy' && typeof raw.groupOnly === 'boolean') {
      this.peerGroupOnly.set(uid, raw.groupOnly);
      this.emit();
      return;
    }
    const del = parseDeleteFrame(raw);
    if (del) {
      this.applyRemoteDelete(uid, del.messageId);
      return;
    }
    const rx = parseReactFrame(raw);
    if (rx) {
      this.applyRemoteReaction(uid, rx.messageId, rx.emoji, rx.on);
      return;
    }
    const declined = parseDeclinedFrame(raw);
    if (declined) {
      const m = this.msgs.get(declined.messageId);
      if (m && m.senderId === this.identity.uid && m.recipients?.[uid]) {
        const who = this.nameOf(uid);
        if (declined.reason === 'direct_not_accepted' && this.contacts.get(uid)?.trust === 'introduced') this.peerGroupOnly.set(uid, true);
        const why =
          declined.reason === 'direct_not_accepted'
            ? `${who} stays group-only, so this was not delivered. You can still talk in your groups, or swap invites to message directly.`
            : declined.reason === 'too_large'
              ? `${who} refused the file because it is too large.`
              : declined.reason === 'busy'
                ? `${who} is receiving other files right now. Try again in a moment.`
                : `${who} could not receive the file.`;
        this.failRecipient(m, uid, why);
        this.emit();
      }
      return;
    }
    const offer = parseFileOffer(raw);
    if (offer) {
      await this.receiveOffer(link, offer);
      return;
    }
    const chunk = parseFileChunk(raw);
    if (chunk) {
      await this.receiveChunk(link, chunk);
      return;
    }
    const direct = parsePeerMessageFrame(raw);
    if (direct) {
      if (direct.senderId !== uid) return;
      // People we only know through a group can message the group, not us, if we chose to stay group-only.
      if (!this.acceptsDirect(uid)) {
        this.sendFrame(uid, { v: 1, kind: 'declined', messageId: direct.messageId, reason: 'direct_not_accepted' });
        return;
      }
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
          ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
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

  private assembler(uid: string): FileAssembler {
    let a = this.assemblers.get(uid);
    if (!a) {
      a = new FileAssembler();
      this.assemblers.set(uid, a);
    }
    return a;
  }

  private async receiveOffer(link: PeerLink, offer: FileOfferFrame): Promise<void> {
    const uid = link.uid;
    const decline = (reason: 'direct_not_accepted' | 'too_large' | 'bad_file' | 'busy'): void => {
      this.sendFrame(uid, { v: 1, kind: 'declined', messageId: offer.messageId, reason });
    };
    if (offer.groupId) {
      if (this.coord.checkMessage(uid, offer.groupId) !== 'ok') return decline('bad_file');
    } else if (!this.acceptsDirect(uid)) {
      return decline('direct_not_accepted');
    }
    if (offer.size > MAX_FILE_BYTES) return decline('too_large');
    // Already have it (the sender is retrying after a dropped link): just confirm.
    if (this.msgs.has(offer.messageId)) {
      this.sendFrame(uid, { v: 1, kind: 'ack', messageId: offer.messageId, state: 'DELIVERED', at: Date.now() });
      return;
    }
    const result = this.assembler(uid).begin(offer);
    if (result !== 'ok') return decline(result);
    this.lastChunkAt.set(uid, Date.now());
  }

  private async receiveChunk(link: PeerLink, chunk: ReturnType<typeof parseFileChunk> & object): Promise<void> {
    const uid = link.uid;
    this.lastChunkAt.set(uid, Date.now());
    const asm = this.assembler(uid);
    const before = asm.progress(chunk.messageId);
    if (before === null) return; // not a transfer we accepted
    const result = await asm.chunk(chunk);
    if (result.status === 'more') {
      if (chunk.index % PROGRESS_EVERY === 0) {
        this.progress.set(chunk.messageId, asm.progress(chunk.messageId) ?? 0);
        this.emit();
      }
      return;
    }
    this.progress.delete(chunk.messageId);
    if (result.status === 'failed') {
      this.sendFrame(uid, { v: 1, kind: 'declined', messageId: chunk.messageId, reason: result.reason });
      this.emit();
      return;
    }
    const { offer, bytes } = result;
    const convId = offer.groupId ?? uid;
    if (offer.groupId && this.coord.checkMessage(uid, offer.groupId) !== 'ok') return;
    await this.deps.store.putFile(offer.messageId, bytes);
    const state = offer.groupId ? this.coord.state(offer.groupId) : null;
    this.ingest(
      {
        messageId: offer.messageId,
        clientMessageId: offer.messageId,
        senderId: uid,
        text: offer.name,
        clientCreatedAt: offer.clientCreatedAt,
        type: 'file',
        transport: 'p2p',
        deliveryState: 'DELIVERED',
        readAt: null,
        conversationId: convId,
        file: { name: offer.name, mime: offer.mime, size: offer.size, sha256: offer.sha256 },
        ...(offer.replyTo ? { replyTo: offer.replyTo } : {}),
      },
      uid,
      convId,
      state ? `${this.nameOf(uid)} in ${state.name}` : this.nameOf(uid),
    );
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
      if (!rec || !this.canDirect(uid)) throw new Error('Pick friends from your list.');
      if (!rec.card.proof) throw new Error(`${this.nameOf(uid)} needs to connect once before being added to a group.`);
      cards.push(rec.card);
    }
    const r = await this.coord.createGroup(name.trim() || 'New group', cards);
    await this.applyGroupResult(r);
    return r.groupId;
  }

  async addGroupMember(groupId: string, uid: string): Promise<void> {
    const rec = this.contacts.get(uid);
    if (!rec || !this.canDirect(uid)) throw new Error('You can only add friends you can message directly.');
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
          link.heardAt = Date.now();
          if (link.isInitiator()) link.lastOfferAt = 0;
          return;
        case 'offer': {
          link.heardAt = Date.now();
          if (link.isInitiator() || link.manual || link.ready || typeof payload.sdp !== 'string') return;
          const answer = await link.acceptOffer(payload.sdp);
          await this.putTo(rec.uid, { t: 'answer', sdp: answer }, 'sig', 120);
          return;
        }
        case 'answer':
          link.heardAt = Date.now();
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
      for (const [uid, asm] of this.assemblers) {
        if (asm.activeCount > 0 && now - (this.lastChunkAt.get(uid) ?? 0) > STALL_MS) asm.clear();
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
    for (const c of this.channels.values()) c.hub.stop();
    this.channels.clear();
    this.blocked.clear();
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
      ? { text: best.deleted ? 'Message deleted' : best.type === 'file' ? filePreviewText(best.text) : best.text, at: best.clientCreatedAt, own: best.senderId === this.identity.uid, senderName: best.senderName ?? this.nameOf(best.senderId) }
      : undefined;
  }

  private unread(convId: string): number {
    let n = 0;
    for (const m of this.msgs.values()) if (m.conversationId === convId && m.senderId !== this.identity.uid && m.readAt == null) n += 1;
    return n;
  }

  private diagnosisOf(uid: string, link: PeerLink): { diagnosis?: Diagnosis } {
    const status = this.hub?.status() ?? 'idle';
    const d = diagnoseConnection(
      {
        signaling: status === 'online' || status === 'connecting' || status === 'error' ? status : 'idle',
        attempts: link.offerAttempt,
        sawPeerReply: link.heardAt > 0,
        localCandidates: link.lastCandidates,
        iceState: link.iceState,
        hasTurn: this.network.turn.length > 0,
        storeForward: this.network.storeForward,
      },
      this.nameOf(uid),
    );
    return d ? { diagnosis: d } : {};
  }

  /** One tap fallback from the "not connecting" banner: messages also go through the relays (sealed, 7 days). */
  enableStoreForward(): void {
    this.network = { ...this.network, storeForward: true };
    saveNetworkConfig(this.network);
    this.emit({ notice: 'Store-and-forward is on. Messages now also travel (encrypted) through the relays, so they arrive even when a direct link is not possible.' });
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
        ...(link && !link.ready && !link.manual ? this.diagnosisOf(c.uid, link) : {}),
        direct: this.canDirect(c.uid),
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
        canMessage: this.canDirect(m.uid),
      }));
      groups.push({
        groupId,
        name: s.name,
        status: isMember ? 'member' : (this.groupNotes.get(groupId) ?? 'removed'),
        members,
        amAdmin: s.members.get(me)?.role === 'admin',
        full: s.members.size >= MAX_GROUP_MEMBERS,
        maxMembers: MAX_GROUP_MEMBERS,
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
      if (own) queued += states.filter((s) => s !== 'FAILED' && RANK[s] < RANK.DELIVERED).length;
      (messages[m.conversationId] ??= []).push({
        ...m,
        own,
        senderName: m.senderName ?? this.nameOf(m.senderId),
        tick: own ? aggregate(m.recipients) : m.deliveryState,
        delivered: states.filter((s) => RANK[s] >= RANK.DELIVERED).length,
        total: states.length,
        reactionChips: summarizeReactions(m.reactions, me),
        ...(this.progress.has(m.messageId) ? { progress: this.progress.get(m.messageId) } : {}),
      });
    }
    const requests: InviteRequest[] = [...this.requestCards.entries()].map(([uid, r]) => ({
      uid,
      name: r.contact.card.name || `Friend ${short(uid)}`,
      safetyNumber: r.safetyNumber,
    }));
    const channels: ChannelView[] = [...this.channels.entries()].map(([name, c]) => ({
      id: `chan:${name}`,
      name,
      unread: this.unread(`chan:${name}`),
      last: this.last(`chan:${name}`),
      conn: c.hub.status() === 'online' ? 'connected' : 'connecting',
    }));
    return { ...this.state, channels, requests, contacts, groups, messages, queued, storageBackend: this.deps.store.backend, signaling: this.hub?.status() ?? 'idle' };
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
