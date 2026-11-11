/**
 * Everything the screens use from a chat engine. Two implementations: `ChatEngine` (the original TypeScript engine) and
 * `HostedChatEngine` (the same behaviour from the Rust engine hosted in the Tauri shell). Same idea as `ChatEngineApi` on Android.
 */
import type { FileMeta, LocalStore } from './localDb';
import type { ChatState, SearchHit } from './engine';

export type SendResult = { ok: true } | { ok: false; error: string };

export interface ChatEngineApi {
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  /** The store the emergency wipe works on. */
  readonly localStore: LocalStore;

  start(): Promise<void>;
  stop(): void;
  setVisible(visible: boolean): void;
  openConversation(convId: string | null): void;
  clearNotice(): void;

  /** The text a friend scans or pastes to add us. */
  myInvite(): string;
  refreshOwnName(name: string): Promise<void>;
  createInvite(): Promise<{ words: string; expiresAt: number }>;
  previewInvite(text: string): Promise<{ uid: string; name: string; safetyNumber: string; already: boolean }>;
  addContact(text: string): Promise<string>;
  retryAnswer(): void;
  clearAnswer(): void;
  acceptRequest(uid: string): Promise<string>;
  dismissRequest(uid: string): void;
  setChecked(uid: string): void;
  safetyNumberFor(uid: string): Promise<string>;
  setNickname(uid: string, name: string): void;
  removeContact(uid: string): void;
  setGroupOnly(value: boolean): void;

  send(convId: string, rawText: string, replyToId?: string): Promise<SendResult>;
  sendFile(convId: string, file: { name: string; mime: string; bytes: Uint8Array }, replyToId?: string): Promise<SendResult>;
  getFile(messageId: string): Promise<{ blob: Blob; meta: FileMeta } | null>;
  retry(messageId: string): Promise<void>;
  deleteMessage(messageId: string, everyone: boolean): void;
  react(messageId: string, emoji: string): void;
  search(query: string, limit?: number): SearchHit[];

  createGroup(name: string, memberUids: string[]): Promise<string>;
  addGroupMember(groupId: string, uid: string): Promise<void>;
  removeGroupMember(groupId: string, uid: string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  renameGroup(groupId: string, name: string): Promise<void>;

  joinChannel(raw: string, persist?: boolean): Promise<string>;
  leaveChannel(convId: string): void;
  muteSender(uid: string): void;

  exportBackup(passphrase: string): Promise<string>;
  importBackup(text: string, passphrase: string): Promise<{ friends: number; groups: number; messages: number }>;

  reloadNetwork(): void;
  enableStoreForward(): void;

  bluetoothAvailable(): Promise<boolean>;
  connectBluetooth(uid: string): Promise<void>;
  createManualOffer(uid: string): Promise<string>;
  applyManualAnswer(code: string): Promise<void>;
  acceptManualOffer(code: string): Promise<string>;
  cancelManual(): void;

  clearLocalData(): Promise<void>;
  clearLocalChat(): Promise<void>;
  eraseLocalChatSession(): void;
}
