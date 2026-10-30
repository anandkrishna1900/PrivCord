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
  type ManualSignal,
  type PairingRecord,
  type PeerControlFrame,
} from '@duochat/protocol';
import { iceServers } from '../config';
import {
  loadPairing,
  purgePeerKeyCaches,
  savePairing,
  signChallenge,
  uidFromPublicJwk,
  type DeviceIdentity,
} from './identity';
import { LocalStore, type OutboxRow } from './localDb';
import { needsDelivery } from './outbox';
import { PeerTransport } from './p2p';

export type EnginePhase = 'starting' | 'ready' | 'error' | 'stopped';
export type P2PState = 'idle' | 'connecting' | 'connected' | 'failed';
export type PeerTrust = 'none' | 'verified' | 'unverified' | 'confirmed';

export interface ChatState {
  phase: EnginePhase;
  uid: string;
  /** The other person's id: known after the first pairing, null before. */
  peerUid: string | null;
  conversationId: string;
  messages: ChatMessage[];
  connectionMode: ConnectionMode;
  p2pState: P2PState;
  p2pConnected: boolean;
  peerTrust: PeerTrust;
  safetyNumber: string | null;
  queuedCount: number;
  storageBackend: 'sqlite' | 'browser';
  error: string | null;
  notice: string | null;
  /** True once a peer key is pinned on this device. */
  paired: boolean;
}

export interface EngineDeps {
  identity: DeviceIdentity;
  conversationId: string;
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
  trust: PeerTrust;
}

function freshAuth(): PeerAuthState {
  return {
    myNonce: '',
    peerHello: null,
    proofSent: false,
    proven: false,
    acknowledged: false,
    authenticated: false,
    timer: 0,
    trust: 'none',
  };
}

const TICK_MS = 4_000;

export class ChatEngine {
  private state: ChatState;
  private listeners = new Set<(state: ChatState) => void>();
  private messages = new Map<string, ChatMessage>();
  private outbox = new Map<string, OutboxRow>();
  private identity: DeviceIdentity;
  private pairing: PairingRecord | null = null;
  private peer: PeerTransport | null = null;
  private auth = freshAuth();
  private frameQueue: unknown[] = [];
  private processingFrames = false;
  private p2pSent = new Set<string>();
  private tickTimer = 0;
  private lastReadWritten: string | null = null;
  private visible = false;
  private manualExpectedKey: JsonWebKey | null = null;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {
    this.identity = deps.identity;
    this.state = {
      phase: 'starting',
      uid: deps.identity.uid,
      peerUid: null,
      conversationId: deps.conversationId,
      messages: [],
      connectionMode: 'OFFLINE_QUEUED',
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      queuedCount: 0,
      storageBackend: deps.store.backend,
      error: null,
      notice: null,
      paired: false,
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
      if (this.stopped) return;
      this.pairing = loadPairing();
      const localMessages = await this.deps.store.loadMessages();
      this.messages = new Map(localMessages.map((message) => [message.messageId, message]));
      try {
        const rows = await this.deps.store.loadOutbox();
        this.outbox = new Map(rows.map((row) => [row.messageId, row]));
      } catch {
        this.outbox = new Map();
      }
      if (this.stopped) return;

      this.setState({
        phase: 'ready',
        paired: this.pairing !== null,
        peerUid: this.pairing?.peerUid ?? null,
        storageBackend: this.deps.store.backend,
        messages: [...this.messages.values()].sort(compareMessages),
        queuedCount: this.outbox.size,
        notice: this.deps.store.initError
          ? `SQLite was unavailable (${this.deps.store.initError}); this browser development store is not secure.`
          : null,
      });
      this.updateConnection();
      this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    } catch (error) {
      if (!this.stopped) this.setState({ phase: 'error', error: errorMessage(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.auth.timer);
    this.peer?.close();
    this.peer = null;
    this.setState({ phase: 'stopped' });
  }

  private tick(): void {
    if (this.stopped || !this.p2pReady()) return;
    this.flushUndelivered();
  }

  private sortedMessages(): ChatMessage[] {
    return [...this.messages.values()].sort(compareMessages);
  }

  private async applyPeerReadThrough(messageId: string): Promise<void> {
    const ordered = this.sortedMessages();
    const index = ordered.findIndex((message) => message.messageId === messageId);
    if (index < 0) return;
    let changed = false;
    for (let i = 0; i <= index; i += 1) {
      const message = ordered[i];
      if (!message || message.senderId !== this.identity.uid) continue;
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
        await this.dropOutbox(updated.messageId);
        changed = true;
      }
    }
    if (changed) this.emitMessages();
  }

  private async dropOutbox(messageId: string): Promise<void> {
    if (!this.outbox.delete(messageId)) return;
    await this.deps.store.removeOutbox(messageId).catch(() => undefined);
  }

  async send(rawText: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const message = createOutgoingMessage({
        senderId: this.identity.uid,
        text: rawText,
      });
      this.messages.set(message.messageId, message);
      await this.deps.store.putMessage(message);
      const row: OutboxRow = {
        messageId: message.messageId,
        recipientId: this.state.peerUid ?? '',
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
    if (!message || message.senderId !== this.identity.uid) return;
    this.p2pSent.delete(messageId);
    await this.deliver(messageId);
  }

  /** Send one own message over the direct channel if it is up; otherwise it stays queued. */
  private async deliver(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || message.senderId !== this.identity.uid) return;
    if (!needsDelivery(message.deliveryState)) return;
    if (!this.p2pReady() || this.p2pSent.has(messageId)) return;
    if (!this.peer?.sendJson(createPeerMessageFrame(message))) return;

    this.p2pSent.add(messageId);
    const updated: ChatMessage = { ...message, transport: 'p2p', deliveryState: 'SENT' };
    this.messages.set(messageId, updated);
    await this.deps.store.updateMessage(messageId, { transport: 'p2p', deliveryState: 'SENT' });
    const row = this.outbox.get(messageId);
    if (row) {
      row.deliveryState = 'SENT';
      row.lastAttemptAt = Date.now();
      await this.deps.store.updateOutbox(messageId, {
        deliveryState: 'SENT',
        lastAttemptAt: row.lastAttemptAt,
      });
    }
    this.emitMessages();
  }

  private flushUndelivered(): void {
    for (const message of this.messages.values()) {
      if (message.senderId === this.identity.uid && needsDelivery(message.deliveryState)) {
        void this.deliver(message.messageId);
      }
    }
  }

  private updateConnection(): void {
    const mode = deriveConnectionMode({
      p2pConnected: this.state.p2pConnected && this.p2pReady(),
      connecting: this.state.p2pState === 'connecting',
      failed: this.state.p2pState === 'failed',
      queuedMessages: this.outbox.size,
    });
    this.setState({ connectionMode: mode, queuedCount: this.outbox.size });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) void this.markRead();
  }

  private async markRead(): Promise<void> {
    const ordered = this.sortedMessages();
    const last = ordered[ordered.length - 1];
    if (!last) return;
    let changed = false;
    const now = Date.now();
    for (const message of ordered) {
      if (message.senderId === this.identity.uid) continue;
      if (message.readAt == null) {
        const updated: ChatMessage = { ...message, readAt: now };
        this.messages.set(message.messageId, updated);
        await this.deps.store.updateMessage(message.messageId, { readAt: now });
        changed = true;
      }
    }
    if (changed) this.emitMessages();
    if (this.lastReadWritten !== last.messageId && this.p2pReady()) {
      this.lastReadWritten = last.messageId;
      this.peer?.sendJson({
        v: 1,
        kind: 'read',
        lastReadMessageId: last.messageId,
        at: now,
      });
    }
  }

  private p2pReady(): boolean {
    return (
      this.auth.authenticated &&
      this.peer?.isOpen === true &&
      (this.auth.trust === 'verified' || this.auth.trust === 'confirmed')
    );
  }

  private newPeer(): PeerTransport {
    this.peer?.close();
    window.clearTimeout(this.auth.timer);
    this.auth = freshAuth();
    this.frameQueue = [];
    this.p2pSent.clear();
    const transport = new PeerTransport(iceServers(), {
      onOpen: () => this.handlePeerOpen(),
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
    });
    this.updateConnection();
    return transport;
  }

  private handlePeerOpen(): void {
    this.auth = freshAuth();
    this.auth.myNonce = randomNonce();
    this.frameQueue = [];
    this.sendHello();
    this.auth.timer = window.setTimeout(() => {
      if (!this.auth.authenticated) {
        this.failPeer('Peer identity verification timed out.');
      }
    }, AUTH_TIMEOUT_MS);
    this.setState({ p2pState: 'connecting' });
  }

  private sendHello(): void {
    if (!this.peer?.isOpen) return;
    this.peer.sendJson({
      v: 1,
      kind: 'hello',
      uid: this.identity.uid,
      deviceId: this.identity.deviceId,
      publicKeyJwk: this.identity.publicJwk,
      nonce: this.auth.myNonce,
    });
  }

  private handlePeerClose(): void {
    window.clearTimeout(this.auth.timer);
    const wasConnected = this.auth.authenticated;
    this.auth = freshAuth();
    this.frameQueue = [];
    this.p2pSent.clear();
    this.lastReadWritten = null;
    this.setState({
      p2pState: wasConnected ? 'failed' : 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      notice: wasConnected
        ? 'Direct connection lost. Exchange a new connection code to reconnect.'
        : this.state.notice,
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
        if (publicKeysEqual(this.identity.publicJwk, frame.publicKeyJwk)) {
          this.failPeer('Refused a connection that claimed our own device identity.');
          return;
        }
        // The account id is a fingerprint of the key, so a peer cannot claim someone else's id.
        if ((await uidFromPublicJwk(frame.publicKeyJwk)) !== frame.uid) {
          this.failPeer('Peer identity does not match its key.');
          return;
        }
        const pinned = this.pairing;
        if (pinned) {
          if (
            frame.uid !== pinned.peerUid ||
            !publicKeysEqual(pinned.publicKeyJwk, frame.publicKeyJwk)
          ) {
            this.failPeer(
              'This is not the device you paired with. Use Reset pairing in Settings to pair a different one.',
            );
            return;
          }
          this.auth.trust = 'verified';
        } else {
          if (
            this.manualExpectedKey &&
            !publicKeysEqual(this.manualExpectedKey, frame.publicKeyJwk)
          ) {
            this.failPeer('Peer identity key does not match the connection code.');
            return;
          }
          this.auth.trust = 'unverified';
        }
        this.auth.peerHello = frame;
        await this.sendProofIfReady();
        return;
      }
      case 'auth_proof': {
        const hello = this.auth.peerHello;
        if (!hello || frame.uid !== hello.uid) {
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
        this.peer?.sendJson({ v: 1, kind: 'auth_ok', uid: this.identity.uid });
        await this.finalizeAuthentication();
        return;
      }
      case 'auth_ok': {
        if (frame.uid !== this.auth.peerHello?.uid) {
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
        if (!message || message.senderId !== this.identity.uid) return;
        const nextState: DeliveryState = frame.state === 'READ' ? 'READ' : 'DELIVERED';
        const updated: ChatMessage = {
          ...message,
          deliveryState:
            nextState === 'READ' || message.deliveryState === 'READ' ? 'READ' : 'DELIVERED',
          readAt: nextState === 'READ' ? frame.at : message.readAt,
        };
        this.messages.set(updated.messageId, updated);
        await this.deps.store.updateMessage(updated.messageId, {
          deliveryState: updated.deliveryState,
          readAt: updated.readAt,
        });
        await this.dropOutbox(updated.messageId);
        this.emitMessages();
        this.updateConnection();
        return;
      }
      case 'read': {
        if (!this.auth.authenticated) return;
        await this.applyPeerReadThrough(frame.lastReadMessageId);
        this.updateConnection();
        return;
      }
      default:
        return;
    }
  }

  private async sendProofIfReady(): Promise<void> {
    if (!this.auth.peerHello || !this.peer?.isOpen) return;
    if (this.auth.proofSent) return;
    const challenge = authChallenge({
      conversationId: this.deps.conversationId,
      uid: this.identity.uid,
      deviceId: this.identity.deviceId,
      nonceSelf: this.auth.myNonce,
      noncePeer: this.auth.peerHello.nonce,
    });
    const signature = await signChallenge(this.identity, challenge);
    this.auth.proofSent = true;
    this.peer?.sendJson({
      v: 1,
      kind: 'auth_proof',
      uid: this.identity.uid,
      signature,
    });
  }

  private async finalizeAuthentication(): Promise<void> {
    const hello = this.auth.peerHello;
    if (this.auth.authenticated || !hello || !this.auth.proven || !this.auth.acknowledged) {
      return;
    }
    this.auth.authenticated = true;
    window.clearTimeout(this.auth.timer);
    const safetyNumber = await deriveSafetyNumber(
      this.identity.publicJwk,
      hello.publicKeyJwk,
    ).catch(() => null);
    const trust = this.auth.trust;
    if (trust === 'verified' && safetyNumber) {
      // Refresh the pinned record's last-connected time.
      this.pairing = savePairing({
        peerUid: hello.uid,
        peerDeviceId: hello.deviceId,
        publicKeyJwk: hello.publicKeyJwk,
        safetyNumber,
      });
    }
    this.setState({
      safetyNumber,
      peerUid: hello.uid,
      peerTrust: trust,
      p2pState: 'connected',
      p2pConnected: trust === 'verified',
      notice:
        trust === 'unverified'
          ? 'Connected. Compare the safety number with your friend, then mark it verified to start chatting.'
          : null,
    });
    if (trust === 'verified') this.onChannelReady();
    this.updateConnection();
  }

  private onChannelReady(): void {
    this.p2pSent.clear();
    this.lastReadWritten = null;
    this.flushUndelivered();
    if (this.visible) void this.markRead();
  }

  private async handlePeerMessage(message: ChatMessage): Promise<void> {
    if (message.senderId !== this.auth.peerHello?.uid) return;
    // Until the safety number is confirmed the peer is not trusted: drop its
    // messages. It resends anything unacknowledged once the channel is verified.
    if (!this.p2pReady()) return;
    const existing = this.messages.get(message.messageId);
    const merged = existing ? mergeMessages([existing], [message])[0] : message;
    if (!merged) return;
    this.messages.set(merged.messageId, merged);
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

  /** The user compared the safety number: pin this peer so later connections are verified. */
  confirmPeer(): void {
    const hello = this.auth.peerHello;
    if (!this.auth.authenticated || !hello || !this.state.safetyNumber) return;
    this.auth.trust = 'confirmed';
    this.pairing = savePairing({
      peerUid: hello.uid,
      peerDeviceId: hello.deviceId,
      publicKeyJwk: hello.publicKeyJwk,
      safetyNumber: this.state.safetyNumber,
    });
    this.setState({
      paired: true,
      peerUid: hello.uid,
      peerTrust: 'confirmed',
      p2pConnected: true,
      notice: null,
    });
    this.onChannelReady();
    this.updateConnection();
  }

  private failPeer(reason: string): void {
    window.clearTimeout(this.auth.timer);
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth();
    this.frameQueue = [];
    this.p2pSent.clear();
    this.setState({
      p2pState: 'failed',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      notice: reason,
    });
    this.updateConnection();
  }

  /**
   * A code is only accepted if its id matches its own key and, once paired, only
   * if it comes from the paired device.
   */
  private async checkSignalIdentity(signal: ManualSignal): Promise<void> {
    if (signal.fromUid === this.identity.uid) {
      throw new Error('This code was created on this device.');
    }
    if ((await uidFromPublicJwk(signal.publicKeyJwk)) !== signal.fromUid) {
      throw new Error('This connection code is corrupted: its identity does not match its key.');
    }
    const pinned = this.pairing;
    if (
      pinned &&
      (signal.fromUid !== pinned.peerUid || !publicKeysEqual(pinned.publicKeyJwk, signal.publicKeyJwk))
    ) {
      throw new Error(
        'This code comes from a different device than the one you paired with. Use Reset pairing in Settings to pair a new one.',
      );
    }
  }

  async createManualOffer(): Promise<string> {
    this.manualExpectedKey = null;
    this.setState({ notice: null });
    const transport = this.newPeer();
    try {
      const sdp = await transport.createOffer();
      return encodeManualSignal(
        createManualSignal({
          kind: 'offer',
          conversationId: this.deps.conversationId,
          fromUid: this.identity.uid,
          fromDeviceId: this.identity.deviceId,
          publicKeyJwk: this.identity.publicJwk,
          sdp,
          nonce: randomNonce(),
        }),
      );
    } catch (error) {
      transport.close();
      this.peer = null;
      this.setState({ p2pState: 'idle' });
      this.updateConnection();
      throw error;
    }
  }

  async applyManualAnswer(code: string): Promise<void> {
    const decoded = decodeManualSignal(code, this.deps.conversationId);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'answer') {
      throw new Error('This code is an offer. The other user must paste your offer and send back an answer.');
    }
    await this.checkSignalIdentity(decoded.value);
    if (!this.peer) throw new Error('Create an offer before pasting an answer.');
    this.manualExpectedKey = decoded.value.publicKeyJwk;
    await this.peer.applyAnswer(decoded.value.sdp);
    this.setState({ p2pState: 'connecting' });
  }

  async acceptManualOffer(code: string): Promise<string> {
    const decoded = decodeManualSignal(code, this.deps.conversationId);
    if (!decoded.ok) throw new Error(decoded.error);
    if (decoded.value.kind !== 'offer') {
      throw new Error('This code is an answer. Paste the offer from the other user instead.');
    }
    await this.checkSignalIdentity(decoded.value);
    this.manualExpectedKey = decoded.value.publicKeyJwk;
    this.setState({ notice: null });
    const transport = this.newPeer();
    try {
      const sdp = await transport.acceptOffer(decoded.value.sdp);
      return encodeManualSignal(
        createManualSignal({
          kind: 'answer',
          conversationId: this.deps.conversationId,
          fromUid: this.identity.uid,
          fromDeviceId: this.identity.deviceId,
          publicKeyJwk: this.identity.publicJwk,
          sdp,
          nonce: randomNonce(),
        }),
      );
    } catch (error) {
      transport.close();
      this.peer = null;
      this.setState({ p2pState: 'idle' });
      this.updateConnection();
      throw error;
    }
  }

  cancelManual(): void {
    this.manualExpectedKey = null;
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth();
    this.p2pSent.clear();
    this.setState({
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
    });
    this.updateConnection();
  }

  clearNotice(): void {
    this.setState({ notice: null, error: null });
  }

  async clearLocalData(): Promise<void> {
    await this.deps.store.clearAll();
    this.messages.clear();
    this.outbox.clear();
    this.lastReadWritten = null;
    this.p2pSent.clear();
    this.emitMessages();
    this.setState({ notice: 'Local messages and the send queue were cleared.' });
  }

  /**
   * Per-conversation kill switch (Option A "CLEAR LOCAL CHAT"): erase every
   * local message, queued message, and delivery record for this conversation.
   */
  async clearLocalChat(): Promise<void> {
    this.messages.clear();
    this.outbox.clear();
    this.lastReadWritten = null;
    this.p2pSent.clear();
    await this.deps.store.clearMessages();
    this.emitMessages();
    this.updateConnection();
  }

  /**
   * Per-conversation kill switch (Option B "DELETE CHAT AND LOCAL SESSION
   * STATE", used together with clearLocalChat): forget the pinned peer and
   * tear down the authenticated direct channel, so any future conversation
   * requires a fresh identity handshake.
   */
  eraseLocalChatSession(): Promise<void> | void {
    this.peer?.close();
    this.peer = null;
    this.auth = freshAuth();
    this.frameQueue = [];
    this.p2pSent.clear();
    this.lastReadWritten = null;
    this.manualExpectedKey = null;
    this.pairing = null;
    this.setState({
      paired: false,
      peerUid: null,
      p2pState: 'idle',
      p2pConnected: false,
      peerTrust: 'none',
      safetyNumber: null,
      notice: 'Local chat erased. Sending again requires a new identity handshake.',
    });
    this.updateConnection();
  }

  /** Forget the pinned peer so a different device can be paired. Messages are kept. */
  resetPairing(): void {
    purgePeerKeyCaches();
    this.eraseLocalChatSession();
    this.setState({ notice: 'Pairing reset. Connect again to pair a device.' });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
