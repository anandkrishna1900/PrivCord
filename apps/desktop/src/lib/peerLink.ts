import {
  AUTH_TIMEOUT_MS,
  BLUETOOTH_PATH,
  authChallenge,
  classifyPath,
  importPublicJwk,
  parsePeerFrame,
  publicKeysEqual,
  randomNonce,
  selectedPairFromStats,
  signatureFromBase64,
  type ConnectionPath,
  type PeerControlFrame,
} from '@duochat/protocol';
import { signChallenge, uidMatchesKeys, type DeviceIdentity } from './identity';
import { PeerTransport } from './p2p';
import { SecureBleLink, type SecureLinkHandlers } from './bleLink';

export type LinkState = 'idle' | 'connecting' | 'connected' | 'failed';

/** What we have pinned for the other side. Their device must prove exactly these keys. */
export interface LinkContact {
  uid: string;
  sign: JsonWebKey;
  dh: JsonWebKey;
}

export interface LinkEnv {
  identity: DeviceIdentity;
  /** Auth-challenge context (same string on both sides). */
  context: string;
  rtcConfig(): RTCConfiguration;
  /** Authenticated and verified: safe to exchange messages. */
  onReady(link: PeerLink): void;
  onClosed(link: PeerLink, wasReady: boolean): void;
  /** Any authenticated frame that is not link housekeeping (messages, acks, group frames...). */
  onFrame(link: PeerLink, frame: unknown): void;
  onChange(link: PeerLink): void;
  onNotice(text: string): void;
  /** Their hello proved these keys: lets legacy contacts (no stored proof) complete their card. */
  onProof(link: PeerLink, hello: Extract<PeerControlFrame, { kind: 'hello' }>): void;
}

interface AuthState {
  myNonce: string;
  peerHello: Extract<PeerControlFrame, { kind: 'hello' }> | null;
  proofSent: boolean;
  proven: boolean;
  acknowledged: boolean;
  authenticated: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const freshAuth = (): AuthState => ({
  myNonce: '',
  peerHello: null,
  proofSent: false,
  proven: false,
  acknowledged: false,
  authenticated: false,
  timer: undefined,
});

/** No frame (not even a pong) for this long means the link is dead. */
export const DEAD_LINK_MS = 14_000;

/** One authenticated connection to one contact (WebRTC or Bluetooth). */
export class PeerLink {
  /** True while a manual (copy-paste) connection is in progress. */
  manual = false;
  state: LinkState = 'idle';
  path: ConnectionPath | null = null;
  transport: PeerTransport | SecureBleLink | null = null;
  lastFrameAt = 0;
  lastOfferAt = 0;
  offerAttempt = 0;
  lastPathAt = 0;
  /** The last time anything arrived from the friend while connecting (an offer, an answer, a "ready"); 0 = nothing. */
  heardAt = 0;
  /** What the last connection attempt found, kept after the attempt is torn down. */
  lastCandidates: { host: number; srflx: number; relay: number } | null = null;
  lastIceState: string | null = null;
  /** Messages already written to the current channel (cleared whenever it reopens). */
  sent = new Set<string>();

  private auth = freshAuth();
  private frameQueue: unknown[] = [];
  private processing = false;
  private offerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public contact: LinkContact,
    private readonly env: LinkEnv,
  ) {}

  get uid(): string {
    return this.contact.uid;
  }

  get ready(): boolean {
    return this.auth.authenticated && this.transport?.isOpen === true;
  }

  get kind(): 'webrtc' | 'ble' | null {
    return this.transport?.kind ?? null;
  }

  /** True while a connection attempt that costs us resources (a transport) is in flight. */
  get busy(): boolean {
    return this.state === 'connecting' && this.transport !== null;
  }

  /** The side with the lower uid makes the offer, so the two never offer at once. */
  isInitiator(): boolean {
    return this.env.identity.uid < this.contact.uid;
  }

  /** Wait until it is fine to write more (WebRTC only; other links never need to wait). */
  waitWritable(): Promise<boolean> {
    return this.transport instanceof PeerTransport ? this.transport.drain() : Promise.resolve(true);
  }

  sendJson(value: unknown): boolean {
    return this.ready ? (this.transport?.sendJson(value) ?? false) : false;
  }

  private setState(state: LinkState): void {
    this.state = state;
    this.env.onChange(this);
  }

  private reset(): void {
    clearTimeout(this.auth.timer);
    clearTimeout(this.offerTimer);
    this.auth = freshAuth();
    this.frameQueue = [];
    this.sent.clear();
    this.path = null;
  }

  close(): void {
    if (this.transport instanceof PeerTransport) this.lastIceState = this.transport.iceState;
    this.reset();
    this.transport?.close();
    this.transport = null;
    this.setState('idle');
  }

  /* ---------------- WebRTC negotiation (the engine moves the SDP through signaling) ---------------- */

  private newWebRtc(): PeerTransport {
    this.transport?.close();
    this.reset();
    const transport = new PeerTransport(this.env.rtcConfig(), {
      onOpen: () => this.handleOpen(transport),
      onClose: () => this.handleClose(transport),
      onFrame: (data) => this.handleRaw(transport, data),
      onStateChange: () => undefined,
      onError: (message) => this.env.onNotice(message),
    });
    this.transport = transport;
    this.setState('connecting');
    return transport;
  }

  async createOffer(): Promise<string> {
    const transport = this.newWebRtc();
    try {
      const sdp = await transport.createOffer();
      this.lastCandidates = transport.candidates;
      this.armTimeout(transport);
      return sdp;
    } catch (error) {
      this.abort(transport);
      throw error;
    }
  }

  async acceptOffer(sdp: string): Promise<string> {
    const transport = this.newWebRtc();
    try {
      const answer = await transport.acceptOffer(sdp);
      this.lastCandidates = transport.candidates;
      this.armTimeout(transport);
      return answer;
    } catch (error) {
      this.abort(transport);
      throw error;
    }
  }

  async applyAnswer(sdp: string): Promise<void> {
    if (!(this.transport instanceof PeerTransport) || this.ready) return;
    await this.transport.applyAnswer(sdp);
  }

  /** WebRTC's verdict on the current attempt (or the one that just ended). */
  get iceState(): string | null {
    return this.transport instanceof PeerTransport ? this.transport.iceState : this.lastIceState;
  }

  private abort(transport: PeerTransport): void {
    if (this.transport === transport) {
      transport.close();
      this.transport = null;
      this.setState('idle');
    }
  }

  private armTimeout(transport: PeerTransport, ms = 40_000): void {
    clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => {
      if (this.transport === transport && !this.auth.authenticated) {
        transport.close();
        this.transport = null;
        this.reset();
        this.setState('failed');
      }
    }, ms);
  }

  /** Bluetooth: the engine builds the secure link; we only supply the handlers that feed this PeerLink. */
  adoptBle(make: (handlers: SecureLinkHandlers) => SecureBleLink): SecureBleLink {
    this.transport?.close();
    this.reset();
    const link: SecureBleLink = make({
      onOpen: () => this.handleOpen(link),
      onClose: () => this.handleClose(link),
      onFrame: (data) => this.handleRaw(link, data),
      onError: (message) => this.env.onNotice(message),
    });
    this.transport = link;
    this.setState('connecting');
    return link;
  }

  /* ---------------- channel events ---------------- */

  private handleOpen(from: PeerTransport | SecureBleLink): void {
    if (this.transport !== from) return;
    clearTimeout(this.offerTimer);
    this.auth = freshAuth();
    this.auth.myNonce = randomNonce();
    this.frameQueue = [];
    this.lastFrameAt = Date.now();
    this.sendHello();
    this.auth.timer = setTimeout(() => {
      if (!this.auth.authenticated) this.fail('The connection could not be verified in time.');
    }, AUTH_TIMEOUT_MS);
  }

  private sendHello(): void {
    const id = this.env.identity;
    this.transport?.sendJson({
      v: 1,
      kind: 'hello',
      uid: id.uid,
      deviceId: id.deviceId,
      publicKeyJwk: id.publicJwk,
      dhJwk: id.dhPublicJwk,
      identityProof: id.identityProof,
      nonce: this.auth.myNonce,
    });
  }

  private handleClose(from: PeerTransport | SecureBleLink): void {
    if (this.transport !== from) return;
    const wasReady = this.auth.authenticated;
    this.reset();
    this.setState(wasReady ? 'failed' : 'idle');
    this.env.onClosed(this, wasReady);
  }

  /** Drop the connection because something is wrong (or it died). */
  fail(reason: string): void {
    const wasReady = this.auth.authenticated;
    this.reset();
    this.transport?.close();
    this.transport = null;
    this.setState('failed');
    this.env.onNotice(reason);
    this.env.onClosed(this, wasReady);
  }

  private handleRaw(from: PeerTransport | SecureBleLink, raw: string): void {
    if (this.transport !== from) return;
    this.lastFrameAt = Date.now();
    try {
      this.frameQueue.push(JSON.parse(raw) as unknown);
    } catch {
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.frameQueue.length > 0) {
        const raw = this.frameQueue.shift();
        const control = parsePeerFrame(raw);
        if (control && (await this.control(control))) continue;
        if (this.auth.authenticated) this.env.onFrame(this, raw);
      }
    } finally {
      this.processing = false;
    }
  }

  /** Returns true if the frame was link housekeeping and is fully handled here. */
  private async control(frame: PeerControlFrame): Promise<boolean> {
    switch (frame.kind) {
      case 'hello': {
        const id = this.env.identity;
        const c = this.contact;
        if (frame.uid !== c.uid || !publicKeysEqual(c.sign, frame.publicKeyJwk) || !publicKeysEqual(c.dh, frame.dhJwk)) {
          this.fail('This is not the device you added. The connection was refused.');
          return true;
        }
        if (publicKeysEqual(id.publicJwk, frame.publicKeyJwk)) {
          this.fail('Refused a connection that claimed our own identity.');
          return true;
        }
        if (!(await uidMatchesKeys(frame.uid, frame.dhJwk, frame.publicKeyJwk, frame.identityProof))) {
          this.fail('The other device failed its identity check.');
          return true;
        }
        this.auth.peerHello = frame;
        this.env.onProof(this, frame);
        await this.sendProof();
        return true;
      }
      case 'auth_proof': {
        const hello = this.auth.peerHello;
        if (!hello || frame.uid !== hello.uid) {
          this.fail('Identity proof arrived out of order.');
          return true;
        }
        const challenge = authChallenge({
          conversationId: this.env.context,
          uid: hello.uid,
          deviceId: hello.deviceId,
          nonceSelf: hello.nonce,
          noncePeer: this.auth.myNonce,
        });
        try {
          const key = await importPublicJwk(hello.publicKeyJwk);
          const ok = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            signatureFromBase64(frame.signature),
            new TextEncoder().encode(challenge),
          );
          if (!ok) {
            this.fail('The other device failed its identity proof.');
            return true;
          }
        } catch {
          this.fail('The other device failed its identity proof.');
          return true;
        }
        this.auth.proven = true;
        this.transport?.sendJson({ v: 1, kind: 'auth_ok', uid: this.env.identity.uid });
        this.finish();
        return true;
      }
      case 'auth_ok': {
        if (frame.uid !== this.auth.peerHello?.uid) {
          this.fail('Identity acknowledgement came from the wrong device.');
          return true;
        }
        this.auth.acknowledged = true;
        this.finish();
        return true;
      }
      case 'ping':
        if (this.auth.authenticated) this.transport?.sendJson({ v: 1, kind: 'pong', at: frame.at });
        return true;
      case 'pong':
        return true;
      default:
        return false; // ack / read: the engine handles them
    }
  }

  private async sendProof(): Promise<void> {
    const hello = this.auth.peerHello;
    const id = this.env.identity;
    if (!hello || this.auth.proofSent || !this.transport?.isOpen) return;
    const challenge = authChallenge({
      conversationId: this.env.context,
      uid: id.uid,
      deviceId: id.deviceId,
      nonceSelf: this.auth.myNonce,
      noncePeer: hello.nonce,
    });
    const signature = await signChallenge(id, challenge);
    this.auth.proofSent = true;
    this.transport.sendJson({ v: 1, kind: 'auth_proof', uid: id.uid, signature });
  }

  private finish(): void {
    if (this.auth.authenticated || !this.auth.peerHello || !this.auth.proven || !this.auth.acknowledged) return;
    this.auth.authenticated = true;
    clearTimeout(this.auth.timer);
    clearTimeout(this.offerTimer);
    this.lastFrameAt = Date.now();
    this.offerAttempt = 0;
    this.sent.clear();
    this.setState('connected');
    void this.refreshPath();
    this.env.onReady(this);
  }

  /* ---------------- housekeeping, called by the engine's timer ---------------- */

  /** Heartbeat and dead-link detection. Returns false if the link was just dropped. */
  beat(now = Date.now()): boolean {
    if (!this.ready) return true;
    if (now - this.lastFrameAt > DEAD_LINK_MS) {
      this.fail('Lost the connection. Reconnecting…');
      return false;
    }
    this.transport?.sendJson({ v: 1, kind: 'ping', at: now });
    if (now - this.lastPathAt > 15_000) void this.refreshPath();
    return true;
  }

  async refreshPath(): Promise<void> {
    this.lastPathAt = Date.now();
    if (this.transport instanceof SecureBleLink) {
      if (this.ready) {
        this.path = BLUETOOTH_PATH;
        this.env.onChange(this);
      }
      return;
    }
    const stats = await this.transport?.getStats();
    if (!stats || !this.ready) return;
    const pair = selectedPairFromStats(stats);
    this.path = pair ? classifyPath(pair.local, pair.remote) : classifyPath('unknown', 'unknown');
    this.env.onChange(this);
  }
}
