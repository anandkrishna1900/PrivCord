/**
 * The desktop's chat engine, run by the Rust engine hosted in the Tauri shell (milestone M7). It gives the screens exactly the
 * `ChatEngineApi` the TypeScript `ChatEngine` gives them: commands go to the Rust engine, and the engine's snapshot is shaped
 * into the `ChatState` the screens read (`shape.ts`). WebRTC and the relay sockets live in `runtime.ts`.
 *
 * Same job as `RustChatEngine` on Android.
 */
import {
  MAX_FILE_BYTES,
  createManualSignal,
  decodeManualSignal,
  encodeManualSignal,
  randomNonce,
  validateFileSize,
  type NetworkConfig,
} from '@duochat/protocol';
import type { ChatState, SearchHit } from '../engine';
import type { ChatEngineApi, SendResult } from '../engineApi';
import { HostedEngine, type EngineBridge } from '../engineBridge';
import { uidMatchesKeys, type DeviceIdentity } from '../identity';
import type { FileMeta, LocalStore, StoredMessage } from '../localDb';
import { HostedRuntime, type RuntimeOptions } from './runtime';
import { shapeState, type SnapshotJson } from './shape';

export interface HostedDeps {
  bridge: EngineBridge;
  network: () => NetworkConfig;
  rtcConfig: () => RTCConfiguration;
  /** The name on our invite card (Settings). */
  ownName: () => string;
  /** `title` is already worded for the user ("Sam" or "Sam in Trip"). */
  onNotify: (message: StoredMessage, title: string) => void;
  /** Turn the "store messages on the relays" setting on and remember it. */
  persistStoreForward: () => void;
  /** Delete a secret from the OS credential store (the engine's identity, on a full wipe). */
  deleteSecret: (key: string) => Promise<void>;
  /** The identity the app holds (its public parts go into manual connection codes) and the conversation id both apps share. */
  identity?: Pick<DeviceIdentity, 'uid' | 'deviceId' | 'publicJwk' | 'dhPublicJwk' | 'identityProof'>;
  context?: string;
  /** The identity the app holds. If the engine reports a different one, starting stops with a clear message. */
  expectedUid?: string;
  /** Tests replace the WebRTC links and relay sockets. */
  runtimeOverrides?: Partial<Pick<RuntimeOptions, 'createTransport' | 'createHub' | 'createBle' | 'now'>>;
}

/** The credential-store key the shell keeps the engine's identity under (see `engine_host.rs`). */
export const ENGINE_IDENTITY_KEY = 'engine-identity-v1';

const LOOKUP_WAIT_MS = 42_000;
const REFRESH_DELAY_MS = 30;

/** The engine's error names, in words (the Android adapter has the same table). */
export function friendly(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const table: [string, string][] = [
    ['EmptyMessage', 'Write something first.'],
    ['MessageTooLong', 'That message is too long.'],
    ['DirectNotAllowed', 'Direct messages with this person are off (group-only).'],
    ['InvalidCard', 'That is not a valid invite. Check the words, or ask your friend to share it again.'],
    ['OwnCard', 'That is your own invite. Send it to a friend instead.'],
    ['UnknownContact', 'That person is not in your friends.'],
    ['NoSuchGroup', 'That group no longer exists.'],
    ['GroupFull', 'That group is full.'],
    ['NotAdmin', 'Only the person who made the group can do that.'],
    ['BadFile', 'That file could not be sent.'],
    ['WeakPassphrase', 'Use a longer passphrase (at least 12 characters).'],
    ['BackupUnreadable', 'That backup could not be opened. Check the passphrase and the file.'],
    ['BackupNotYours', 'That backup belongs to a different identity.'],
    ['Busy', 'The engine is busy. Try again in a moment.'],
    ['NoSignaling', 'No connection service is set up. Turn one on in Settings > Connection.'],
  ];
  for (const [code, words] of table) if (text.includes(code)) return words;
  return text || 'Something went wrong.';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export class HostedChatEngine implements ChatEngineApi {
  private readonly engine: HostedEngine;
  private runtime: HostedRuntime | null = null;
  private snapshot: SnapshotJson | null = null;
  private state: ChatState;
  private readonly listeners = new Set<(state: ChatState) => void>();
  private card = '';
  private visible = false;
  private active: string | null = null;
  private stopped = false;
  private phase: ChatState['phase'] = 'starting';
  private notice: string | null = null;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private again = false;
  private current: Promise<void> = Promise.resolve();
  private lookup: { resolve: (p: { uid: string; name: string; safetyNumber: string; already: boolean }) => void; reject: (e: Error) => void } | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly deps: HostedDeps) {
    this.engine = new HostedEngine(deps.bridge);
    this.state = this.shape(null);
  }

  /* ------------------------------------------------------------------ state */

  getState(): ChatState {
    return this.state;
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private shape(s: SnapshotJson | null): ChatState {
    const net = this.deps.network();
    const r = this.runtime;
    if (!s) {
      return {
        channels: [], answer: null, invite: null, requests: [], phase: this.phase, uid: '', contacts: [], groups: [], messages: {},
        signaling: 'idle', storageBackend: 'sqlite', queued: 0, error: this.error, notice: this.notice,
      };
    }
    return shapeState(s, {
      ownName: this.deps.ownName(),
      signaling: r?.signalingStatus() ?? 'idle',
      signalingConfigured: net.signaling.length > 0,
      hasTurn: net.turn.length > 0,
      storeForward: net.storeForward,
      via: () => 'webrtc',
      facts: (uid) => r?.factsFor(uid),
      progress: r?.progress ?? new Map(),
      incoming: r?.incoming ?? new Map(),
      phase: this.phase,
      error: this.error,
      notice: this.notice,
    });
  }

  private emit(): void {
    this.state = this.shape(this.snapshot);
    for (const l of this.listeners) l(this.state);
  }

  /** Build the state again soon (many events arrive together; one rebuild answers them all). */
  private scheduleRefresh(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  /**
   * Read the engine's snapshot and show it. A call made while a read is running is not lost and not answered early: the read
   * runs once more, and every caller gets its promise, so "await refresh()" means the screen state is up to date.
   */
  private refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) {
      this.again = true;
      return this.current;
    }
    this.refreshing = true;
    this.current = (async () => {
      try {
        do {
          this.again = false;
          try {
            const next = await this.engine.snapshot<SnapshotJson>();
            // Never go back to an older picture than the one on screen.
            if (!this.snapshot || next.seq >= this.snapshot.seq) this.snapshot = next;
            this.runtime?.setOwnUid(next.own_uid ?? '');
          } catch {
            // Keep the picture we have.
          }
          this.emit();
        } while (this.again && !this.stopped);
      } finally {
        this.refreshing = false;
      }
    })();
    return this.current;
  }

  clearNotice(): void {
    this.notice = null;
    this.error = null;
    this.emit();
  }

  private say(notice: string): void {
    this.notice = notice;
    this.emit();
  }

  private fail(error: unknown): string {
    const message = friendly(error);
    this.error = message;
    this.emit();
    return message;
  }

  /* ------------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.phase = 'starting';
    this.emit();
    try {
      // Listen first: what the engine says while it starts (it subscribes to our mailbox at once) must not be missed.
      this.runtime = new HostedRuntime({
        engine: this.engine,
        network: this.deps.network,
        rtcConfig: this.deps.rtcConfig,
        changed: () => this.scheduleRefresh(),
        ...this.deps.runtimeOverrides,
      });
      await this.runtime.attach();
      this.off = await this.engine.on('event', (e) => this.onEvent(e));
      await this.engine.start();
      const name = this.deps.ownName();
      if (name) await this.engine.call('set_display_name', { name }).catch(() => undefined);
      await this.engine.call('set_store_forward', { value: this.deps.network().storeForward }).catch(() => undefined);
      this.card = (await this.engine.call<string>('own_card', { name: name || null }).catch(() => '')) ?? '';
      await this.refresh();
      const own = this.snapshot?.own_uid ?? null;
      if (this.deps.expectedUid && own !== this.deps.expectedUid) {
        throw new Error(
          own
            ? 'The engine holds a different identity than this app. Restart the app; if this stays, use Settings > Security > Erase everything.'
            : 'The Rust engine has no identity yet.',
        );
      }
      this.phase = 'ready';
      this.emit();
    } catch (error) {
      this.phase = 'error';
      this.error = friendly(error);
      this.emit();
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.off?.();
    this.runtime?.stop();
    void this.engine.stop().catch(() => undefined);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.active) void this.engine.call('mark_conversation_read', { conversation: this.active }).catch(() => undefined);
  }

  openConversation(convId: string | null): void {
    this.active = convId;
    if (convId) void this.engine.call('mark_conversation_read', { conversation: convId }).then(() => this.scheduleRefresh()).catch(() => undefined);
  }

  /* ------------------------------------------------------------------ engine events the screens care about */

  private onEvent(event: unknown): void {
    if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, Record<string, unknown>>;
      if (e.InviteFound && this.lookup) {
        this.lookup.resolve({
          uid: String(e.InviteFound.uid),
          name: String(e.InviteFound.name),
          safetyNumber: String(e.InviteFound.safety_number),
          already: e.InviteFound.already === true,
        });
        this.lookup = null;
      } else if (e.MessageAdded && e.MessageAdded.own === false) {
        void this.incoming(String(e.MessageAdded.conversation), String(e.MessageAdded.message_id));
      }
    } else if (event === 'InviteLookupFailed' && this.lookup) {
      this.lookup.reject(new Error('Could not find that invite. Check the words, make sure your friend still has the invite screen open, then try again.'));
      this.lookup = null;
    }
    this.scheduleRefresh();
  }

  /** A message arrived: read at once if that chat is open on screen, otherwise a notification. */
  private async incoming(conversation: string, messageId: string): Promise<void> {
    if (this.visible && this.active === conversation) {
      await this.engine.call('mark_conversation_read', { conversation }).catch(() => undefined);
      return;
    }
    await this.refresh();
    const message = this.state.messages[conversation]?.find((m) => m.messageId === messageId);
    if (!message) return;
    const person = this.state.contacts.find((c) => c.uid === conversation)?.name;
    const group = this.state.groups.find((g) => g.groupId === conversation);
    const channel = this.state.channels.find((c) => c.id === conversation);
    const title = person ?? (group ? `${message.senderName} in ${group.name}` : channel ? `${message.senderName} in #${channel.name}` : message.senderName);
    this.deps.onNotify(message, title);
  }

  /* ------------------------------------------------------------------ identity and friends */

  myInvite(): string {
    return this.card;
  }

  async refreshOwnName(name: string): Promise<void> {
    await this.engine.call('set_display_name', { name: name.trim() });
    this.card = (await this.engine.call<string>('own_card', { name: name.trim() || null })) ?? this.card;
  }

  async createInvite(): Promise<{ words: string; expiresAt: number }> {
    const invite = await this.engine.call<{ words: string; expires_at: number }>('create_invite').catch((e) => {
      throw new Error(friendly(e));
    });
    this.scheduleRefresh();
    return { words: invite.words, expiresAt: invite.expires_at };
  }

  async previewInvite(text: string): Promise<{ uid: string; name: string; safetyNumber: string; already: boolean }> {
    let mine: NonNullable<typeof this.lookup> | null = null;
    const found = new Promise<{ uid: string; name: string; safetyNumber: string; already: boolean }>((resolve, reject) => {
      mine = { resolve, reject };
      this.lookup = mine;
    });
    // Only ever clear our own lookup: a later lookup must not be cancelled by this one's timer.
    const release = () => {
      if (this.lookup === mine) this.lookup = null;
    };
    let preview: { uid: string; name: string; safety_number: string; already: boolean } | null;
    try {
      preview = await this.engine.call('preview_invite', { text });
    } catch (e) {
      release();
      throw new Error(friendly(e));
    }
    if (preview) {
      release();
      return { uid: preview.uid, name: preview.name, safetyNumber: preview.safety_number, already: preview.already };
    }
    // Six words: the search is running.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        release();
        reject(new Error('Could not find that invite. Check the words, make sure your friend still has the invite screen open, then try again.'));
      }, LOOKUP_WAIT_MS);
    });
    return Promise.race([found, timeout]).finally(() => clearTimeout(timer));
  }

  async addContact(text: string): Promise<string> {
    const preview = await this.previewInvite(text);
    try {
      const uid = await this.engine.call<string>('accept_invite', { text });
      // The screens show the new friend as soon as this returns, so the state must already have them.
      await this.refresh();
      this.say(preview.already ? `${preview.name} is already in your friends.` : `${preview.name} added. Connecting…`);
      return uid;
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  retryAnswer(): void {
    void this.engine.call('retry_answer').catch((e) => this.fail(e));
  }

  clearAnswer(): void {
    void this.engine.call('clear_answer').then(() => this.scheduleRefresh()).catch(() => undefined);
  }

  async acceptRequest(uid: string): Promise<string> {
    try {
      const accepted = await this.engine.call<string>('accept_request', { uid });
      this.scheduleRefresh();
      return accepted;
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  dismissRequest(uid: string): void {
    void this.engine.call('dismiss_request', { uid }).then(() => this.scheduleRefresh()).catch(() => undefined);
  }

  setChecked(uid: string): void {
    void this.engine.call('set_checked', { uid, checked: true }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  async safetyNumberFor(uid: string): Promise<string> {
    return this.snapshot?.contacts.find((c) => c.uid === uid)?.safety_number ?? '';
  }

  setNickname(uid: string, name: string): void {
    void this.engine.call('rename_contact', { uid, name }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  removeContact(uid: string): void {
    // The screens call this inside a try/catch and expect a refusal at once, so check the one rule here.
    if (this.state.groups.some((g) => g.members.some((m) => m.uid === uid))) {
      throw new Error('Leave the groups you share first, then you can remove this friend.');
    }
    void this.engine.call('remove_contact', { uid }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  setGroupOnly(value: boolean): void {
    void this.engine.call('set_group_only', { value }).then(() => this.scheduleRefresh()).catch(() => undefined);
  }

  /* ------------------------------------------------------------------ messages and files */

  private kindOf(convId: string): 'channel' | 'group' | 'direct' {
    if (convId.startsWith('chan:')) return 'channel';
    return this.state.groups.some((g) => g.groupId === convId) ? 'group' : 'direct';
  }

  async send(convId: string, rawText: string, replyToId?: string): Promise<SendResult> {
    try {
      const kind = this.kindOf(convId);
      if (kind === 'channel') await this.engine.call('send_channel_message', { name: convId.slice(5), text: rawText });
      else if (kind === 'group') await this.engine.call('send_group_message', { group: convId, text: rawText, reply_to: replyToId });
      else await this.engine.sendMessage(convId, rawText, replyToId);
      this.scheduleRefresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  }

  async sendFile(convId: string, file: { name: string; mime: string; bytes: Uint8Array }, replyToId?: string): Promise<SendResult> {
    try {
      const tooBig = validateFileSize(file.bytes.length);
      if (tooBig) return { ok: false, error: tooBig };
      if (file.bytes.length > MAX_FILE_BYTES) return { ok: false, error: 'That file is too big.' };
      const args = { name: file.name, mime: file.mime || 'application/octet-stream', data: toBase64(file.bytes), reply_to: replyToId };
      if (this.kindOf(convId) === 'group') await this.engine.call('send_group_file', { group: convId, ...args });
      else await this.engine.call('send_file', { peer: convId, ...args });
      this.scheduleRefresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  }

  async getFile(messageId: string): Promise<{ blob: Blob; meta: FileMeta } | null> {
    const file = await this.engine.call<{ name: string; mime: string; data: string } | null>('load_file', { message_id: messageId }).catch(() => null);
    if (!file) return null;
    const bytes = fromBase64(file.data);
    return {
      blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.mime }),
      meta: { name: file.name, mime: file.mime, size: bytes.length, sha256: '' },
    };
  }

  async retry(messageId: string): Promise<void> {
    // Send it again from the start (a refused file, say), and dial now instead of waiting out the retry delay.
    await this.engine.call('retry_message', { message_id: messageId }).catch((e) => this.fail(e));
    await this.engine.call('reset_dial_backoff', {}).catch(() => undefined);
    this.scheduleRefresh();
  }

  deleteMessage(messageId: string, everyone: boolean): void {
    void this.engine.call('delete_message', { message_id: messageId, everyone }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  react(messageId: string, emoji: string): void {
    void this.engine.call('react', { message_id: messageId, emoji }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  /** The screens search as the person types and expect an answer at once, so this scans what is on screen. */
  search(query: string, limit = 50): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const hits: SearchHit[] = [];
    for (const [convId, list] of Object.entries(this.state.messages)) {
      const convName =
        this.state.contacts.find((c) => c.uid === convId)?.name ??
        this.state.groups.find((g) => g.groupId === convId)?.name ??
        (convId.startsWith('chan:') ? `#${convId.slice(5)}` : convId);
      for (const m of list) {
        if (m.deleted || !m.text.toLowerCase().includes(needle)) continue;
        hits.push({ messageId: m.messageId, convId, convName, senderName: m.senderName, text: m.text, at: m.clientCreatedAt });
      }
    }
    return hits.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /* ------------------------------------------------------------------ groups and channels */

  async createGroup(name: string, memberUids: string[]): Promise<string> {
    try {
      const id = await this.engine.call<string>('create_group', { name, members: memberUids });
      this.scheduleRefresh();
      return id;
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  private async group(command: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.engine.call(command, args);
      this.scheduleRefresh();
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  addGroupMember(groupId: string, uid: string): Promise<void> {
    return this.group('add_group_member', { group: groupId, uid });
  }

  removeGroupMember(groupId: string, uid: string): Promise<void> {
    return this.group('remove_group_member', { group: groupId, uid });
  }

  leaveGroup(groupId: string): Promise<void> {
    return this.group('leave_group', { group: groupId });
  }

  renameGroup(groupId: string, name: string): Promise<void> {
    return this.group('rename_group', { group: groupId, name });
  }

  async joinChannel(raw: string): Promise<string> {
    try {
      const name = await this.engine.call<string>('join_channel', { name: raw });
      this.scheduleRefresh();
      return name;
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  leaveChannel(convId: string): void {
    void this.engine.call('leave_channel', { name: convId.replace(/^chan:/, '') }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  muteSender(uid: string): void {
    void this.engine.call('set_muted', { uid, muted: true }).then(() => this.scheduleRefresh()).catch((e) => this.fail(e));
  }

  /* ------------------------------------------------------------------ backup, network, settings */

  async exportBackup(passphrase: string): Promise<string> {
    try {
      return await this.engine.call<string>('export_backup', { passphrase });
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  async importBackup(text: string, passphrase: string): Promise<{ friends: number; groups: number; messages: number }> {
    try {
      const r = await this.engine.call<{ friends: number; groups: number; messages: number }>('import_backup', { text, passphrase });
      this.scheduleRefresh();
      return r;
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  reloadNetwork(): void {
    this.runtime?.reloadNetwork();
    void this.engine.call('set_store_forward', { value: this.deps.network().storeForward }).catch(() => undefined);
  }

  enableStoreForward(): void {
    this.deps.persistStoreForward();
    void this.engine.call('set_store_forward', { value: true }).catch(() => undefined);
    this.say('Store-and-forward is on. Messages now also travel (encrypted) through the relays, so they arrive even when a direct link is not possible.');
  }

  /* ------------------------------------------------------------------ Bluetooth and manual connection codes */

  async bluetoothAvailable(): Promise<boolean> {
    return (await this.runtime?.bluetoothAvailable()) ?? false;
  }

  async connectBluetooth(uid: string): Promise<void> {
    if (!this.runtime) throw new Error('The engine is not ready yet.');
    if (!this.state.contacts.some((c) => c.uid === uid)) throw new Error('Add your friend first.');
    await this.runtime.connectBluetooth(uid);
  }

  private encodeManual(kind: 'offer' | 'answer', sdp: string): string {
    const id = this.deps.identity;
    if (!id || !this.deps.context) throw new Error('Manual connection codes are not available right now.');
    return encodeManualSignal(
      createManualSignal({
        kind,
        conversationId: this.deps.context,
        fromUid: id.uid,
        fromDeviceId: id.deviceId,
        publicKeyJwk: id.publicJwk,
        dhJwk: id.dhPublicJwk,
        identityProof: id.identityProof,
        sdp,
        nonce: randomNonce(),
      }),
    );
  }

  /** A code from the other device: must be for us, a friend, and honest about whose keys it carries. */
  private async decodeManual(code: string, want: 'offer' | 'answer'): Promise<{ from: string; sdp: string }> {
    const context = this.deps.context;
    if (!context || !this.deps.identity) throw new Error('Manual connection codes are not available right now.');
    const decoded = decodeManualSignal(code, context);
    if (!decoded.ok) throw new Error(decoded.error);
    const signal = decoded.value;
    if (signal.kind !== want) {
      throw new Error(want === 'offer' ? 'That is a reply. Paste the offer from your friend instead.' : "That is an offer. Paste it on your friend's device and send back the reply.");
    }
    if (signal.fromUid === this.deps.identity.uid) throw new Error('That code was made on this device.');
    if (!(await uidMatchesKeys(signal.fromUid, signal.dhJwk, signal.publicKeyJwk, signal.identityProof))) {
      throw new Error('That code is damaged: its identity does not match its key.');
    }
    if (!this.state.contacts.some((c) => c.uid === signal.fromUid)) {
      throw new Error('That code is from someone who is not in your friends yet. Add them with their invite first.');
    }
    return { from: signal.fromUid, sdp: signal.sdp };
  }

  async createManualOffer(uid: string): Promise<string> {
    if (!this.runtime) throw new Error('The engine is not ready yet.');
    if (!this.state.contacts.some((c) => c.uid === uid)) throw new Error('Add this friend first.');
    return this.encodeManual('offer', await this.runtime.manualOffer(uid));
  }

  async applyManualAnswer(code: string): Promise<void> {
    const { from, sdp } = await this.decodeManual(code, 'answer');
    await this.runtime?.manualApply(from, sdp);
  }

  async acceptManualOffer(code: string): Promise<string> {
    const { from, sdp } = await this.decodeManual(code, 'offer');
    if (!this.runtime) throw new Error('The engine is not ready yet.');
    return this.encodeManual('answer', await this.runtime.manualAccept(from, sdp));
  }

  cancelManual(): void {
    this.runtime?.cancelManual();
  }

  /* ------------------------------------------------------------------ emergency wipe */

  /**
   * The emergency wipe works on a `LocalStore`. With the engine, the data lives in the engine's own database, so this stands in
   * for it: clearing it wipes the engine (and its identity secret), and there is no separate schema to destroy.
   */
  get localStore(): LocalStore {
    // The wipe stops networking (and so the engine) before it erases data, so this cannot rely on the engine running: the
    // shell deletes the database and the identity itself, and a failure fails the step instead of reading "erased".
    const wipe = async () => {
      await this.engine.call('wipe_everything').catch(() => undefined);
      if (this.deps.bridge.erase) await this.deps.bridge.erase();
      await this.deps.deleteSecret(ENGINE_IDENTITY_KEY).catch(() => undefined);
    };
    return { clearAll: wipe, destroySchema: async () => undefined } as unknown as LocalStore;
  }

  async clearLocalData(): Promise<void> {
    await this.localStore.clearAll();
    this.snapshot = null;
    this.emit();
  }

  async clearLocalChat(): Promise<void> {
    for (const conversation of Object.keys(this.state.messages)) {
      await this.engine.call('wipe_conversation', { conversation, erase_session: false }).catch(() => undefined);
    }
    this.scheduleRefresh();
  }

  eraseLocalChatSession(): void {
    // The full wipe (`localStore.clearAll`) closes every session with the rest of the engine's data.
  }
}
