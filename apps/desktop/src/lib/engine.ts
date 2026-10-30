import {
  AUTH_TIMEOUT_MS,
  authChallenge,
  compareMessages,
  createManualSignal,
  createOutgoingMessage,
  createPeerMessageFrame,
  decodeManualSignal,
  deriveConnectionMode,
  deriveSafetyNumber,
  encodeManualSignal,
  importPublicJwk,
  mergeMessages,
  parsePeerFrame,
  parsePeerMessageFrame,
  publicKeysEqual,
  randomNonce,
  signatureFromBase64,
  type ChatMessage,
  type ConnectionMode,
  type DeliveryState,
  type PeerControlFrame,
} from '@duochat/protocol';
import type { QueryDocumentSnapshot, DocumentData, Unsubscribe } from 'firebase/firestore';
import { config, iceServers } from '../config';
import {
  checkCloud,
  deleteSignals,
  ensureOwnProfile,
  fetchOlderMessages,
  loadProfile,
  registerDevice,
  sendSignal,
  subscribeLatestMessages,
  subscribePeerReadState,
  subscribeProfile,
  subscribeSignals,
  touchLastSeen,
  updateDisplayName,
  writeMessage,
  writeReadState,
  type IncomingSignal,
  type UserProfile,
} from './cloud';
import {
  cachePeerDeviceKey,
  loadOrCreateIdentity,
  resolvePeerDeviceKey,
  signChallenge,
  type DeviceIdentity,
} from './identity';
import { LocalStore, type OutboxRow } from './localDb';
import { allowsCloudWrites, canAttemptDelivery, shouldAttempt } from './outbox';
import { PeerTransport } from './p2p';
import type { MessageMode } from './settings';

export type EnginePhase = 'starting' | 'ready' | 'error' | 'stopped';
export type P2PState = 'idle' | 'connecting' | 'connected' | 'failed';
export type PeerTrust = 'none' | 'verified' | 'unverified' | 'confirmed';

export interface ChatState {
  phase: EnginePhase;
  uid: string;
  peerUid: string;
  conversationId: string;
  messageMode: MessageMode;
  selfProfile: UserProfile | null;
  peerProfile: UserProfile | null;
  messages: ChatMessage[];
  connectionMode: ConnectionMode;
  cloudConnected: boolean;
  p2pState: P2PState;
  p2pConnected: boolean;
  peerTrust: PeerTrust;
  safetyNumber: string | null;
  queuedCount: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  storageBackend: 'sqlite' | 'browser';
  error: string | null;
  notice: string | null;
  lastSyncAt: number | null;
  manualMode: boolean;
  peerKeySource: 'cloud' | 'cache' | 'manual' | null;
}

export interface EngineDeps {
  uid: string;
  peerUid: string;
  conversationId: string;
  email: string;
  displayName: string;
  messageMode?: MessageMode;
  store: LocalStore;
  onNotify: (message: ChatMessage) => void;
}

interface PeerAuthState {
  myNonce: string;
  peerHello: Extract<PeerControlFrame, { kind: 'hello' }> | null;
  proofSent: boolean;
  proven: boolean;
  acknowledged: boolean;
  authenticated: boolean;
  timer: number;
  origin: 'auto' | 'manual';
  trust: PeerTrust;
}

function freshAuth(origin: 'auto' | 'manual'): PeerAuthState {
  return {
    myNonce: '',
    peerHello: null,
    proofSent: false,
    proven: false,
    acknowledged: false,
    authenticated: false,
    timer: 0,
    origin,
    trust: 'none',
  };
}

const TICK_MS = 4_000;
const HEALTH_CONNECTED_MS = 20_000;
const HEALTH_OFFLINE_MS = 8_000;
const OFFER_INTERVAL_MS = 20_000;
const PRESENCE_INTERVAL_MS = 120_000;

export class ChatEngine {
  private state: ChatState;
  private listeners = new Set<(state: ChatState) => void>();
  private unsubs: Unsubscribe[] = [];
  private messages = new Map<string, ChatMessage>();
  private outbox = new Map<string, OutboxRow>();
  private identity: DeviceIdentity | null = null;
  private peer: PeerTransport | null = null;
  private auth = freshAuth('auto');
  private frameQueue: unknown[] = [];
  private processingFrames = false;
  private cloudOk = false;
  private draining = false;
  private cloudInFlight = new Set<string>();
  private p2pSent = new Set<string>();
  private tickTimer = 0;
  private healthTimer = 0;
  private offerTimer = 0;
  private lastOfferAt = 0;
  private lastPresenceAt = 0;
  private lastReadWritten: string | null = null;
  private visible = false;
  private manualMode = false;
  private manualExpectedKey: JsonWebKey | null = null;
  private peerKeySource: 'cloud' | 'cache' | 'manual' | null = null;
  private cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  private stopped = false;
  private knownIds = new Set<string>();
  private selfLoaded = false;

  constructor(private readonly deps: EngineDeps) {
    this.state = {
      phase: 'starting',
      uid: deps.uid,
      peerUid: deps.peerUid,
      conversationId: deps.conversationId,
      messageMode: deps.messageMode ?? 'cloud',
      selfProfile: null,
      peerProfile: null,
      messages: [],
      connectionMode: 'CONNECTING',
      cloudConnected: false,
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      queuedCount: 0,
      hasOlder: false,
      loadingOlder: false,
      storageBackend: deps.store.backend,
      error: null,
      notice: null,
      lastSyncAt: null,
      manualMode: false,
      peerKeySource: null,
    };
  }

  getState(): ChatState {
    return this.state;
  }

  /** Direct access to the local store (used by the kill switch executor). */
  get localStore(): LocalStore {
    return this.deps.store;
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private emitMessages(): void {
    this.setState({
      messages: [...this.messages.values()].sort(compareMessages),
      queuedCount: this.outbox.size,
      storageBackend: this.deps.store.backend,
    });
  }

  async start(): Promise<void> {
    try {
      await this.deps.store.init();
      this.identity = await loadOrCreateIdentity(this.deps.uid);
      const ownProfilePromise = loadProfile(this.deps.uid).catch(() => null);
      const peerProfilePromise = loadProfile(this.deps.peerUid).catch(() => null);
      const [ownProfile, peerProfile] = await Promise.all([
        ownProfilePromise,
        peerProfilePromise,
      ]);
      if (ownProfile) this.selfLoaded = true;

      try {
        await ensureOwnProfile(
          this.deps.uid,
          this.deps.email,
          this.deps.displayName,
        );
      } catch (error) {
        this.setState({ notice: `Profile setup failed: ${errorMessage(error)}` });
      }

      try {
        await registerDevice(
          this.deps.uid,
          this.identity.deviceId,
          this.identity.publicJwk,
        );
      } catch (error) {
        this.setState({
          notice: `Device identity could not be registered: ${errorMessage(error)}`,
        });
      }

      const localMessages = await this.deps.store.loadMessages();
      this.messages = new Map(localMessages.map((message) => [message.messageId, message]));
      this.knownIds = new Set(this.messages.keys());
      try {
        const rows = await this.deps.store.loadOutbox();
        this.outbox = new Map(rows.map((row) => [row.messageId, row]));
      } catch {
        this.outbox = new Map();
      }

      this.setState({
        phase: 'ready',
        selfProfile: ownProfile,
        peerProfile,
        storageBackend: this.deps.store.backend,
        messages: [...this.messages.values()].sort(compareMessages),
        queuedCount: this.outbox.size,
        notice: this.deps.store.initError
          ? `SQLite was unavailable (${this.deps.store.initError}); this browser development store is not secure.`
          : null,
      });

      this.startSubscriptions();
      this.updateConnection();
      this.scheduleHealthCheck(0);
      this.tickTimer = window.setInterval(() => void this.tick(), TICK_MS);
      void this.touchPresence();
    } catch (error) {
      this.setState({ phase: 'error', error: errorMessage(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.healthTimer);
    window.clearTimeout(this.offerTimer);
    window.clearTimeout(this.auth.timer);
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.peer?.close();
    this.peer = null;
    this.setState({ phase: 'stopped' });
  }

  private startSubscriptions(): void {
    const { conversationId, uid, peerUid } = this.deps;
    this.unsubs.push(
      subscribeLatestMessages(
        conversationId,
        (messages, cursor) => {
          this.cursor = cursor;
          this.cloudOk = true;
          this.setState({ cloudConnected: true, lastSyncAt: Date.now() });
          this.setState({ hasOlder: messages.length >= 100 });
          void this.mergeCloudMessages(messages);
          this.updateConnection();
        },
        (error) => this.handleCloudError(error),
      ),
    );
    this.unsubs.push(
      subscribeProfile(
        uid,
        (profile) => {
          this.selfLoaded = true;
          this.setState({ selfProfile: profile });
        },
        () => undefined,
      ),
    );
    this.unsubs.push(
      subscribeProfile(
        peerUid,
        (profile) => this.setState({ peerProfile: profile }),
        () => undefined,
      ),
    );
    this.unsubs.push(
      subscribePeerReadState(
        conversationId,
        peerUid,
        (messageId) => {
          if (messageId) void this.applyPeerReadThrough(messageId);
        },
        () => undefined,
      ),
    );
    this.unsubs.push(
      subscribeSignals(
        conversationId,
        uid,
        (signal) => void this.handleSignal(signal),
        (error) => this.handleCloudError(error),
      ),
    );
  }

  private handleCloudError(error: Error): void {
    this.cloudOk = false;
    this.updateConnection();
    if (String(error).toLowerCase().includes('permission')) {
      this.setState({
        error:
          'Firestore denied access. This account is not one of the two approved members, or setup is incomplete.',
      });
    } else {
      this.setState({ notice: 'Cloud unavailable. Direct delivery and local queueing remain active.' });
    }
  }

  private async mergeCloudMessages(cloudMessages: ChatMessage[]): Promise<void> {
    const changed: ChatMessage[] = [];
    const newlyReceived: ChatMessage[] = [];
    for (const cloud of cloudMessages) {
      const existing = this.messages.get(cloud.messageId);
      if (existing) {
        const normalized: ChatMessage =
          cloud.senderId === this.deps.uid
            ? {
                ...cloud,
                deliveryState:
                  existing.deliveryState === 'READ' ||
                  existing.deliveryState === 'DELIVERED'
                    ? existing.deliveryState
                    : 'SENT',
              }
            : cloud;
        const merged = mergeMessages([existing], [normalized])[0];
        if (merged) {
          this.messages.set(merged.messageId, merged);
          changed.push(merged);
        }
      } else {
        this.messages.set(cloud.messageId, cloud);
        changed.push(cloud);
        if (cloud.senderId !== this.deps.uid && !this.knownIds.has(cloud.messageId)) {
          newlyReceived.push(cloud);
        }
      }
      this.knownIds.add(cloud.messageId);
      if (cloud.senderId === this.deps.uid) {
        this.outbox.delete(cloud.messageId);
        await this.deps.store.removeOutbox(cloud.messageId).catch(() => undefined);
      }
    }
    for (const message of changed) {
      await this.deps.store.putMessage(message).catch(() => undefined);
    }
    this.emitMessages();
    for (const message of newlyReceived) {
      this.deps.onNotify(message);
    }
    if (newlyReceived.length > 0 && this.visible) {
      void this.markRead();
    }
  }

  private async applyPeerReadThrough(messageId: string): Promise<void> {
    const ordered = this.sortedMessages();
    const index = ordered.findIndex((message) => message.messageId === messageId);
    if (index < 0) return;
    let changed = false;
    for (let i = 0; i <= index; i += 1) {
      const message = ordered[i];
      if (!message || message.senderId !== this.deps.uid) continue;
      if (message.deliveryState !== 'READ') {
        const updated: ChatMessage = {
          ...message,
          deliveryState: 'READ',
          readAt: message.readAt ?? Date.now(),
        };
        this.messages.set(updated.messageId, updated);
        await this.deps.store.updateMessage(updated.messageId, {
          deliveryState: 'READ',
          readAt: updated.readAt,
        });
        changed = true;
      }
    }
    if (changed) this.emitMessages();
  }

  private sortedMessages(): ChatMessage[] {
    return [...this.messages.values()].sort(compareMessages);
  }

  async loadOlder(): Promise<void> {
    if (!this.cursor || this.state.loadingOlder || !this.cloudOk) return;
    this.setState({ loadingOlder: true });
    try {
      const page = await fetchOlderMessages(this.deps.conversationId, this.cursor);
      this.cursor = page.cursor;
      const changed: ChatMessage[] = [];
      for (const message of page.messages) {
        if (!this.messages.has(message.messageId)) {
          this.messages.set(message.messageId, message);
          changed.push(message);
          this.knownIds.add(message.messageId);
        }
      }
      for (const message of changed) await this.deps.store.putMessage(message);
      this.setState({ hasOlder: page.hasMore });
      this.emitMessages();
    } catch (error) {
      this.setState({ notice: `Could not load older messages: ${errorMessage(error)}` });
    } finally {
      this.setState({ loadingOlder: false });
    }
  }

  async send(rawText: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.identity) return { ok: false, error: 'Identity is not ready yet.' };
    try {
      const message = createOutgoingMessage({
        senderId: this.deps.uid,
        text: rawText,
      });
      this.messages.set(message.messageId, message);
      this.knownIds.add(message.messageId);
      await this.deps.store.putMessage(message);
      const row: OutboxRow = {
        messageId: message.messageId,
        recipientId: this.deps.peerUid,
        payload: JSON.stringify(message),
        createdAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: null,
        deliveryState: 'QUEUED',
        lastError: null,
      };
      this.outbox.set(row.messageId, row);
      await this.deps.store.enqueueOutbox(row);
      this.emitMessages();
      void this.deliver(message.messageId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async retry(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || message.senderId !== this.deps.uid) return;
    const updated: ChatMessage = { ...message, deliveryState: 'QUEUED' };
    this.messages.set(messageId, updated);
    await this.deps.store.updateMessage(messageId, { deliveryState: 'QUEUED' });
    const existing = this.outbox.get(messageId);
    const row: OutboxRow =
      existing ?? {
        messageId,
        recipientId: this.deps.peerUid,
        payload: JSON.stringify(updated),
        createdAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: null,
        deliveryState: 'QUEUED',
        lastError: null,
      };
    row.deliveryState = 'QUEUED';
    row.lastError = null;
    row.lastAttemptAt = null;
    this.outbox.set(messageId, row);
    await this.deps.store.enqueueOutbox(row);
    this.p2pSent.delete(messageId);
    this.emitMessages();
    await this.deliver(messageId);
  }

  private async requeueFailedMessages(): Promise<void> {
    const failed = [...this.messages.values()].filter(
      (message) => message.senderId === this.deps.uid && message.deliveryState === 'FAILED',
    );
    if (failed.length === 0) return;
    for (const message of failed) {
      const queued: ChatMessage = { ...message, deliveryState: 'QUEUED' };
      this.messages.set(queued.messageId, queued);
      await this.deps.store.updateMessage(queued.messageId, { deliveryState: 'QUEUED' });
      const existing = this.outbox.get(queued.messageId);
      const row: OutboxRow =
        existing ?? {
          messageId: queued.messageId,
          recipientId: this.deps.peerUid,
          payload: JSON.stringify(queued),
          createdAt: Date.now(),
          attemptCount: 0,
          lastAttemptAt: null,
          deliveryState: 'QUEUED',
          lastError: null,
        };
      row.attemptCount = 0;
      row.lastAttemptAt = null;
      row.deliveryState = 'QUEUED';
      row.lastError = null;
      this.outbox.set(queued.messageId, row);
      await this.deps.store.enqueueOutbox(row);
      this.p2pSent.delete(queued.messageId);
    }
    this.emitMessages();
  }

  private async deliver(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || message.senderId !== this.deps.uid || message.syncedToCloud) return;
    let changed = false;
    let sentDirect = false;

    if (this.p2pReady() && !this.p2pSent.has(messageId)) {
      const sent = this.peer?.sendJson(createPeerMessageFrame(message)) ?? false;
      if (sent) {
        sentDirect = true;
        this.p2pSent.add(messageId);
        const updated: ChatMessage = {
          ...message,
          transport: 'p2p',
          deliveryState:
            message.deliveryState === 'READ' || message.deliveryState === 'DELIVERED'
              ? message.deliveryState
              : 'SENT',
        };
        this.messages.set(messageId, updated);
        await this.deps.store.updateMessage(messageId, {
          transport: 'p2p',
          deliveryState: updated.deliveryState,
        });
        const row = this.outbox.get(messageId);
        if (row) {
          row.deliveryState = updated.deliveryState;
          row.lastAttemptAt = Date.now();
          await this.deps.store.updateOutbox(messageId, {
            deliveryState: updated.deliveryState,
            lastAttemptAt: row.lastAttemptAt,
          });
        }
        changed = true;
      }
    }

    if (this.state.messageMode === 'direct') {
      if (changed) {
        this.emitMessages();
        this.updateConnection();
      }
      return;
    }

    if (allowsCloudWrites(this.state.messageMode) && this.cloudOk && !this.cloudInFlight.has(messageId)) {
      this.cloudInFlight.add(messageId);
      try {
        await writeMessage(this.deps.conversationId, message);
        const current = this.messages.get(messageId) ?? message;
        const synced: ChatMessage = {
          ...current,
          syncedToCloud: true,
          deliveryState:
            current.deliveryState === 'QUEUED' || current.deliveryState === 'FAILED'
              ? 'SENT'
              : current.deliveryState,
        };
        this.messages.set(messageId, synced);
        await this.deps.store.putMessage(synced);
        await this.deps.store.removeOutbox(messageId);
        this.outbox.delete(messageId);
        changed = true;
      } catch (error) {
        const row = this.outbox.get(messageId);
        if (row) {
          const attempts = row.attemptCount + 1;
          row.attemptCount = attempts;
          row.lastAttemptAt = Date.now();
          row.lastError = errorMessage(error);
          if (!sentDirect && attempts >= 5) row.deliveryState = 'FAILED';
          this.outbox.set(messageId, row);
          await this.deps.store.updateOutbox(messageId, {
            attemptCount: row.attemptCount,
            lastAttemptAt: row.lastAttemptAt,
            lastError: row.lastError,
            deliveryState: row.deliveryState,
          });
          if (!sentDirect && attempts >= 5) {
            const failed: ChatMessage = { ...currentOf(this.messages, messageId), deliveryState: 'FAILED' };
            this.messages.set(messageId, failed);
            await this.deps.store.updateMessage(messageId, { deliveryState: 'FAILED' });
          }
        }
        const errorText = errorMessage(error).toLowerCase();
        if (errorText.includes('permission')) {
          this.setState({
            error: 'The cloud rejected this message. Check the two-user allowlist and security rules.',
          });
        } else {
          this.cloudOk = false;
        }
        changed = true;
      } finally {
        this.cloudInFlight.delete(messageId);
      }
    }

    if (changed) {
      this.emitMessages();
      this.updateConnection();
    }
  }

  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const rows = await this.deps.store.loadOutbox();
      this.outbox = new Map(rows.map((row) => [row.messageId, row]));
      const now = Date.now();
      for (const row of rows) {
        if (!shouldAttempt(row, now)) continue;
        if (
          !canAttemptDelivery({
            mode: this.state.messageMode,
            cloudConnected: this.cloudOk,
            p2pConnected: this.p2pReady(),
          })
        ) {
          continue;
        }
        await this.deliver(row.messageId);
      }
      this.emitMessages();
    } catch {
      // Outbox drain retries on the next tick.
    } finally {
      this.draining = false;
    }
  }

  private flushUnsynced(): void {
    for (const message of this.messages.values()) {
      if (message.senderId === this.deps.uid && !message.syncedToCloud) {
        void this.deliver(message.messageId);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.drainOutbox();
    if (this.identity && Date.now() - this.lastPresenceAt > PRESENCE_INTERVAL_MS) {
      void this.touchPresence();
    }
    await this.maybeStartAutomaticOffer();
    this.updateConnection();
  }

  private async touchPresence(): Promise<void> {
    this.lastPresenceAt = Date.now();
    await touchLastSeen(this.deps.uid);
  }

  private scheduleHealthCheck(delay: number): void {
    window.clearTimeout(this.healthTimer);
    this.healthTimer = window.setTimeout(async () => {
      if (this.stopped) return;
      const ok = await checkCloud();
      const wasOk = this.cloudOk;
      this.cloudOk = ok;
      if (ok) {
        this.setState({ lastSyncAt: Date.now() });
        if (!wasOk) {
          await this.requeueFailedMessages();
          this.p2pSent.clear();
          void this.drainOutbox();
          this.setState({
            notice:
              this.state.messageMode === 'direct'
                ? 'Cloud signaling restored. Direct messages remain on this device.'
                : 'Cloud synchronization restored. Reconciling queued messages.',
          });
        }
      } else if (wasOk) {
        this.setState({
          notice:
            'Cloud unavailable. Existing direct connections and the local queue are still available.',
        });
      }
      this.updateConnection();
      this.scheduleHealthCheck(ok ? HEALTH_CONNECTED_MS : HEALTH_OFFLINE_MS);
    }, delay);
  }

  private updateConnection(): void {
    const mode = deriveConnectionMode({
      cloudConnected: this.cloudOk,
      p2pConnected: this.state.p2pConnected && this.p2pReady(),
      connecting: this.state.p2pState === 'connecting',
      reconnecting: !this.cloudOk && this.state.p2pState === 'idle',
      failed: !this.cloudOk && this.state.p2pState === 'failed',
      queuedMessages: this.outbox.size,
    });
    this.setState({
      connectionMode: mode,
      cloudConnected: this.cloudOk,
      queuedCount: this.outbox.size,
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) void this.markRead();
  }

  setMessageMode(mode: MessageMode): void {
    if (mode === this.state.messageMode) return;
    this.setState({
      messageMode: mode,
      notice:
        mode === 'direct'
          ? 'Direct mode enabled. New messages stay on this device until the direct channel accepts them.'
          : 'Cloud mode enabled. Pending messages will be uploaded to the cloud.',
    });
    if (mode === 'cloud') {
      this.lastReadWritten = null;
      void this.markRead();
      if (this.cloudOk) void this.drainOutbox();
    } else {
      this.p2pSent.clear();
      void this.requeueFailedMessages()
        .then(() => this.drainOutbox())
        .catch(() => undefined);
    }
  }

  private async markRead(): Promise<void> {
    const ordered = this.sortedMessages();
    const last = ordered[ordered.length - 1];
    if (!last) return;
    let changed = false;
    const now = Date.now();
    for (const message of ordered) {
      if (message.senderId === this.deps.uid) continue;
      if (message.readAt == null) {
        const updated: ChatMessage = { ...message, readAt: now };
        this.messages.set(message.messageId, updated);
        await this.deps.store.updateMessage(message.messageId, { readAt: now });
        changed = true;
      }
    }
    if (changed) this.emitMessages();
    if (this.lastReadWritten !== last.messageId) {
      this.lastReadWritten = last.messageId;
      if (allowsCloudWrites(this.state.messageMode) && this.cloudOk) {
        void writeReadState(
          this.deps.conversationId,
          this.deps.uid,
          last.messageId,
        ).catch(() => undefined);
      }
      this.peer?.sendJson({
        v: 1,
        kind: 'read',
        lastReadMessageId: last.messageId,
        at: now,
      });
    }
  }

  private isInitiator(): boolean {
    return this.deps.uid < this.deps.peerUid;
  }

  private p2pReady(): boolean {
    return (
      this.auth.authenticated &&
      this.peer?.isOpen === true &&
      (this.auth.trust === 'verified' || this.auth.trust === 'confirmed')
    );
  }

  private newPeer(origin: 'auto' | 'manual'): PeerTransport {
    this.peer?.close();
    window.clearTimeout(this.offerTimer);
    window.clearTimeout(this.auth.timer);
    this.auth = freshAuth(origin);
    this.frameQueue = [];
    this.p2pSent.clear();
    const transport = new PeerTransport(iceServers(), {
      onOpen: () => this.handlePeerOpen(origin),
      onClose: () => this.handlePeerClose(),
      onFrame: (data) => this.handlePeerFrame(data),
      onStateChange: () => undefined,
      onError: (message) => this.setState({ notice: message }),
    });
    this.peer = transport;
    this.setState({
      p2pState: 'connecting',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      peerKeySource: null,
    });
    return transport;
  }

  private async maybeStartAutomaticOffer(): Promise<void> {
    if (
      !this.isInitiator() ||
      !this.cloudOk ||
      this.manualMode ||
      this.p2pReady() ||
      this.state.p2pState === 'connecting' ||
      Date.now() - this.lastOfferAt < OFFER_INTERVAL_MS
    ) {
      return;
    }
    this.lastOfferAt = Date.now();
    const transport = this.newPeer('auto');
    try {
      const sdp = await transport.createOffer();
      await sendSignal(this.deps.conversationId, {
        from: this.deps.uid,
        to: this.deps.peerUid,
        fromDeviceId: this.identity?.deviceId ?? '',
        kind: 'offer',
        sdp,
      });
      this.offerTimer = window.setTimeout(() => {
        if (!this.auth.authenticated) {
          if (this.peer === transport) {
            transport.close();
            this.peer = null;
          }
          this.setState({ p2pState: 'failed' });
          this.updateConnection();
        }
      }, 25_000);
    } catch (error) {
      this.peer = null;
      transport.close();
      this.setState({
        p2pState: 'failed',
        notice: `Direct connection offer failed: ${errorMessage(error)}`,
      });
    }
  }

  private async handleSignal(signal: IncomingSignal): Promise<void> {
    if (signal.from !== this.deps.peerUid) {
      void deleteSignals(this.deps.conversationId, [signal.id]);
      return;
    }
    if (this.manualMode) {
      void deleteSignals(this.deps.conversationId, [signal.id]);
      return;
    }
    try {
      if (signal.kind === 'offer' && !this.isInitiator()) {
        if (this.p2pReady()) return;
        const transport = this.newPeer('auto');
        const answer = await transport.acceptOffer(signal.sdp);
        await sendSignal(this.deps.conversationId, {
          from: this.deps.uid,
          to: this.deps.peerUid,
          fromDeviceId: this.identity?.deviceId ?? '',
          kind: 'answer',
          sdp: answer,
        });
      } else if (signal.kind === 'answer' && this.isInitiator() && this.peer) {
        await this.peer.applyAnswer(signal.sdp);
      }
    } catch (error) {
      this.setState({
        p2pState: 'failed',
        notice: `Signaling failed: ${errorMessage(error)}`,
      });
      this.updateConnection();
    } finally {
      void deleteSignals(this.deps.conversationId, [signal.id]);
    }
  }

  private handlePeerOpen(origin: 'auto' | 'manual'): void {
    window.clearTimeout(this.offerTimer);
    if (!this.identity) {
      this.peer?.close();
      return;
    }
    this.auth = freshAuth(origin);
    this.auth.myNonce = randomNonce();
    this.frameQueue = [];
    this.auth.authenticated = false;
    this.sendHello();
    window.clearTimeout(this.auth.timer);
    this.auth.timer = window.setTimeout(() => {
      if (!this.auth.authenticated) {
        this.failPeer('Peer identity verification timed out.');
      }
    }, AUTH_TIMEOUT_MS);
    this.setState({ p2pState: 'connecting' });
  }

  private sendHello(): void {
    if (!this.identity || !this.peer?.isOpen) return;
    this.peer.sendJson({
      v: 1,
      kind: 'hello',
      uid: this.deps.uid,
      deviceId: this.identity.deviceId,
      publicKeyJwk: this.identity.publicJwk,
      nonce: this.auth.myNonce,
    });
  }

  private handlePeerClose(): void {
    window.clearTimeout(this.auth.timer);
    window.clearTimeout(this.offerTimer);
    const wasConnected = this.auth.authenticated;
    this.auth = freshAuth(this.manualMode ? 'manual' : 'auto');
    this.frameQueue = [];
    this.p2pSent.clear();
    this.setState({
      p2pState: wasConnected ? 'failed' : 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      peerKeySource: null,
    });
    this.updateConnection();
  }

  private handlePeerFrame(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as unknown;
      this.frameQueue.push(parsed);
      void this.processFrameQueue();
    } catch {
      // Ignore malformed frames.
    }
  }

  private async processFrameQueue(): Promise<void> {
    if (this.processingFrames) return;
    this.processingFrames = true;
    try {
      while (this.frameQueue.length > 0) {
        const raw = this.frameQueue.shift();
        const control = parsePeerFrame(raw);
        if (control) {
          await this.handleControlFrame(control);
          continue;
        }
        const message = parsePeerMessageFrame(raw);
        if (message) {
          if (!this.auth.authenticated) continue;
          await this.handlePeerMessage(message);
        }
      }
    } finally {
      this.processingFrames = false;
    }
  }

  private async handleControlFrame(frame: PeerControlFrame): Promise<void> {
    switch (frame.kind) {
      case 'hello': {
        if (frame.uid !== this.deps.peerUid) {
          this.failPeer('A different account attempted to connect.');
          return;
        }
        const origin = this.auth.origin;
        if (!this.identity) return;
        if (publicKeysEqual(this.identity.publicJwk, frame.publicKeyJwk)) {
          this.failPeer('Refused a connection that claimed our own device identity.');
          return;
        }
        const resolved = await resolvePeerDeviceKey(
          this.deps.peerUid,
          frame.deviceId,
        );
        if (resolved) {
          if (!publicKeysEqual(resolved.key, frame.publicKeyJwk)) {
            this.failPeer('Peer identity key does not match the registered device.');
            return;
          }
          this.auth.trust = 'verified';
          this.peerKeySource = resolved.source;
          if (resolved.source === 'cloud') {
            cachePeerDeviceKey(this.deps.peerUid, frame.deviceId, frame.publicKeyJwk);
          }
        } else if (
          origin === 'manual' &&
          this.manualExpectedKey &&
          publicKeysEqual(this.manualExpectedKey, frame.publicKeyJwk)
        ) {
          this.auth.trust = 'unverified';
          this.peerKeySource = 'manual';
        } else if (origin === 'manual') {
          this.auth.trust = 'unverified';
          this.peerKeySource = 'manual';
        } else {
          this.failPeer(
            'Could not verify the peer device key. Register the peer device in Firestore or use a manual code.',
          );
          return;
        }
        this.auth.peerHello = frame;
        await this.sendProofIfReady();
        return;
      }
      case 'auth_proof': {
        const hello = this.auth.peerHello;
        if (!hello || frame.uid !== this.deps.peerUid) {
          this.failPeer('Peer identity proof arrived out of order.');
          return;
        }
        const challenge = authChallenge({
          conversationId: this.deps.conversationId,
          uid: hello.uid,
          deviceId: hello.deviceId,
          nonceSelf: hello.nonce,
          noncePeer: this.auth.myNonce,
        });
        try {
          const key = await importPublicJwk(hello.publicKeyJwk);
          const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            signatureFromBase64(frame.signature),
            new TextEncoder().encode(challenge),
          );
          if (!valid) {
            this.failPeer('Peer identity proof is invalid.');
            return;
          }
        } catch {
          this.failPeer('Peer identity proof could not be verified.');
          return;
        }
        this.auth.proven = true;
        this.peer?.sendJson({ v: 1, kind: 'auth_ok', uid: this.deps.uid });
        await this.finalizeAuthentication();
        return;
      }
      case 'auth_ok': {
        if (frame.uid !== this.deps.peerUid) {
          this.failPeer('Peer acknowledgement came from the wrong account.');
          return;
        }
        this.auth.acknowledged = true;
        await this.finalizeAuthentication();
        return;
      }
      case 'ack': {
        if (!this.auth.authenticated) return;
        const message = this.messages.get(frame.messageId);
        if (!message) return;
        const nextState: DeliveryState =
          frame.state === 'READ' ? 'READ' : 'DELIVERED';
        const updated: ChatMessage = {
          ...message,
          deliveryState:
            nextState === 'READ' ? 'READ' : message.deliveryState === 'READ' ? 'READ' : 'DELIVERED',
          readAt: nextState === 'READ' ? frame.at : message.readAt,
        };
        this.messages.set(updated.messageId, updated);
        await this.deps.store.updateMessage(updated.messageId, {
          deliveryState: updated.deliveryState,
          readAt: updated.readAt,
        });
        if (this.state.messageMode === 'direct' && updated.deliveryState !== 'FAILED') {
          this.outbox.delete(updated.messageId);
          await this.deps.store.removeOutbox(updated.messageId).catch(() => undefined);
        }
        this.emitMessages();
        return;
      }
      case 'read': {
        if (!this.auth.authenticated) return;
        await this.applyPeerReadThrough(frame.lastReadMessageId);
        return;
      }
      default:
        return;
    }
  }

  private async sendProofIfReady(): Promise<void> {
    if (!this.auth.peerHello || !this.identity || !this.peer?.isOpen) return;
    if (this.auth.proofSent) return;
    const challenge = authChallenge({
      conversationId: this.deps.conversationId,
      uid: this.deps.uid,
      deviceId: this.identity.deviceId,
      nonceSelf: this.auth.myNonce,
      noncePeer: this.auth.peerHello.nonce,
    });
    const signature = await signChallenge(this.identity, challenge);
    this.auth.proofSent = true;
    this.peer?.sendJson({
      v: 1,
      kind: 'auth_proof',
      uid: this.deps.uid,
      signature,
    });
  }

  private async finalizeAuthentication(): Promise<void> {
    if (
      this.auth.authenticated ||
      !this.auth.peerHello ||
      !this.auth.proven ||
      !this.auth.acknowledged ||
      !this.identity
    ) {
      return;
    }
    this.auth.authenticated = true;
    window.clearTimeout(this.auth.timer);
    window.clearTimeout(this.offerTimer);
    const safetyNumber = await deriveSafetyNumber(
      this.identity.publicJwk,
      this.auth.peerHello.publicKeyJwk,
    ).catch(() => null);
    const trust = this.auth.trust;
    this.setState({
      safetyNumber,
      peerTrust: trust,
      peerKeySource: this.peerKeySource,
      p2pState: 'connected',
      p2pConnected: trust === 'verified' || trust === 'confirmed',
      notice:
        trust === 'unverified'
          ? 'Direct channel established. Compare the safety number with your friend, then mark it verified.'
          : null,
    });
    if (trust === 'verified' || trust === 'confirmed') {
      this.p2pSent.clear();
      this.flushUnsynced();
    }
    this.updateConnection();
  }

  private async handlePeerMessage(message: ChatMessage): Promise<void> {
    if (message.senderId !== this.deps.peerUid) return;
    const existing = this.messages.get(message.messageId);
    const merged = existing
      ? mergeMessages([existing], [message])[0]
      : message;
    if (!merged) return;
    this.messages.set(merged.messageId, merged);
    this.knownIds.add(merged.messageId);
    await this.deps.store.putMessage(merged);
    this.emitMessages();
    this.peer?.sendJson({
      v: 1,
      kind: 'ack',
      messageId: merged.messageId,
      state: 'DELIVERED',
      at: Date.now(),
    });
    if (!existing) this.deps.onNotify(merged);
    if (this.visible) void this.markRead();
  }

  confirmPeer(): void {
    if (!this.auth.authenticated || !this.auth.peerHello) return;
    this.auth.trust = 'confirmed';
    cachePeerDeviceKey(
      this.deps.peerUid,
      this.auth.peerHello.deviceId,
      this.auth.peerHello.publicKeyJwk,
    );
    this.setState({
      peerTrust: 'confirmed',
      p2pConnected: true,
      notice: null,
    });
    this.p2pSent.clear();
    this.flushUnsynced();
    this.updateConnection();
  }

  private failPeer(reason: string): void {
    window.clearTimeout(this.auth.timer);
    window.clearTimeout(this.offerTimer);
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth(this.manualMode ? 'manual' : 'auto');
    this.frameQueue = [];
    this.p2pSent.clear();
    this.setState({
      p2pState: 'failed',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      peerKeySource: null,
      notice: reason,
    });
    this.updateConnection();
  }

  async createManualOffer(): Promise<string> {
    if (!this.identity) throw new Error('Identity is not ready.');
    this.manualMode = true;
    this.manualExpectedKey = null;
    this.setState({ manualMode: true, notice: null });
    const transport = this.newPeer('manual');
    try {
      const sdp = await transport.createOffer();
      return encodeManualSignal(
        createManualSignal({
          kind: 'offer',
          conversationId: this.deps.conversationId,
          fromUid: this.deps.uid,
          fromDeviceId: this.identity.deviceId,
          publicKeyJwk: this.identity.publicJwk,
          sdp,
          nonce: randomNonce(),
        }),
      );
    } catch (error) {
      this.manualMode = false;
      transport.close();
      throw error;
    }
  }

  async applyManualAnswer(code: string): Promise<void> {
    const decoded = decodeManualSignal(code, this.deps.conversationId);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'answer') {
      throw new Error('This code is an offer. The other user must paste your offer and send back an answer.');
    }
    if (decoded.value.fromUid !== this.deps.peerUid) {
      throw new Error('This connection code belongs to a different account.');
    }
    if (!this.peer) throw new Error('Create an offer before pasting an answer.');
    const resolved = await resolvePeerDeviceKey(
      this.deps.peerUid,
      decoded.value.fromDeviceId,
    );
    if (resolved && !publicKeysEqual(resolved.key, decoded.value.publicKeyJwk)) {
      throw new Error('This answer does not match the verified peer device key.');
    }
    this.manualExpectedKey = decoded.value.publicKeyJwk;
    await this.peer.applyAnswer(decoded.value.sdp);
    this.setState({ manualMode: true, p2pState: 'connecting' });
  }

  async acceptManualOffer(code: string): Promise<string> {
    if (!this.identity) throw new Error('Identity is not ready.');
    const decoded = decodeManualSignal(code, this.deps.conversationId);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'offer') {
      throw new Error('This code is an answer. Paste the offer from the other user instead.');
    }
    if (decoded.value.fromUid !== this.deps.peerUid) {
      throw new Error('This connection code belongs to a different account.');
    }
    this.manualMode = true;
    this.manualExpectedKey = decoded.value.publicKeyJwk;
    this.setState({ manualMode: true, notice: null });
    const resolved = await resolvePeerDeviceKey(
      this.deps.peerUid,
      decoded.value.fromDeviceId,
    );
    if (resolved && !publicKeysEqual(resolved.key, decoded.value.publicKeyJwk)) {
      throw new Error('This offer does not match the verified peer device key.');
    }
    const transport = this.newPeer('manual');
    try {
      const sdp = await transport.acceptOffer(decoded.value.sdp);
      return encodeManualSignal(
        createManualSignal({
          kind: 'answer',
          conversationId: this.deps.conversationId,
          fromUid: this.deps.uid,
          fromDeviceId: this.identity.deviceId,
          publicKeyJwk: this.identity.publicJwk,
          sdp,
          nonce: randomNonce(),
        }),
      );
    } catch (error) {
      transport.close();
      this.peer = null;
      this.manualMode = false;
      throw error;
    }
  }

  cancelManual(): void {
    this.manualMode = false;
    this.manualExpectedKey = null;
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth('auto');
    this.p2pSent.clear();
    this.setState({
      manualMode: false,
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      peerKeySource: null,
    });
    this.updateConnection();
  }

  async changeDisplayName(name: string): Promise<void> {
    await updateDisplayName(this.deps.uid, name);
  }

  requestDirectConnection(): void {
    this.lastOfferAt = 0;
    this.setState({
      notice: this.isInitiator()
        ? 'Looking for a direct peer path?'
        : 'Direct negotiation is initiated by the peer with the lower account ID. Use manual setup if automatic signaling is unavailable.',
    });
    if (this.isInitiator()) {
      void this.maybeStartAutomaticOffer();
    }
  }

  clearNotice(): void {
    this.setState({ notice: null, error: null });
  }

  async clearLocalData(): Promise<void> {
    await this.deps.store.clearAll();
    this.messages.clear();
    this.outbox.clear();
    this.knownIds.clear();
    this.lastReadWritten = null;
    this.p2pSent.clear();
    this.emitMessages();
    this.setState({ notice: 'Local messages, queue, and cached metadata were cleared.' });
  }

  /**
   * Per-conversation kill switch (Option A "CLEAR LOCAL CHAT"): erase every
   * local message, draft queue row, and delivery record for this conversation.
   * The peer subscription is detached during the wipe so cloud sync cannot
   * repopulate the store mid-erase, then re-attached for future traffic.
   */
  async clearLocalChat(): Promise<void> {
    const unsubs = this.unsubs;
    this.unsubs = [];
    for (const unsubscribe of unsubs) unsubscribe();
    this.messages.clear();
    this.outbox.clear();
    this.knownIds.clear();
    this.lastReadWritten = null;
    this.p2pSent.clear();
    try {
      await this.deps.store.clearMessages();
    } finally {
      if (!this.stopped) {
        this.startSubscriptions();
        this.emitMessages();
        this.updateConnection();
      }
    }
    this.emitMessages();
  }

  /**
   * Per-conversation kill switch (Option B "DELETE CHAT AND LOCAL SESSION
   * STATE", used together with clearLocalChat): forget the peer trust cache
   * binding and tear down the authenticated direct channel, so any future
   * conversation requires a fresh identity handshake.
   */
  eraseLocalChatSession(): Promise<void> | void {
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth('auto');
    this.frameQueue = [];
    this.p2pSent.clear();
    this.lastReadWritten = null;
    this.manualMode = false;
    this.manualExpectedKey = null;
    this.setState({
      manualMode: false,
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      peerKeySource: null,
      notice: 'Local chat erased. Sending again requires a new identity handshake.',
    });
    this.updateConnection();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function currentOf(
  messages: Map<string, ChatMessage>,
  messageId: string,
): ChatMessage {
  return (
    messages.get(messageId) ?? {
      messageId,
      clientMessageId: messageId,
      senderId: '',
      text: '',
      clientCreatedAt: Date.now(),
      type: 'text',
      transport: 'cloud',
      deliveryState: 'FAILED',
      syncedToCloud: false,
    }
  );
}
