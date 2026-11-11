import type { ChatMessage, DeliveryState, ReplyRef } from '@duochat/protocol';
import type { TextCipher } from './encryption';

export interface OutboxRow {
  messageId: string;
  recipientId: string;
  payload: string;
  createdAt: number;
  attemptCount: number;
  lastAttemptAt: number | null;
  deliveryState: DeliveryState;
  lastError: string | null;
}

/** A message plus where it belongs and how each recipient is doing (one entry for a direct chat). */
export interface FileMeta {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface StoredMessage extends ChatMessage {
  /** Present when `type` is 'file'. The bytes live in the file store under the message id. */
  file?: FileMeta;
  /** Channel messages: the sender's self-chosen name plus a short id (they are not in our contacts). */
  senderName?: string;
  /** Who reacted with what (uid to emoji). */
  reactions?: Record<string, string>;
  /** Deleted for everyone: only a tombstone is kept. */
  deleted?: boolean;
  /** Contact uid for a direct chat, group id for a group chat. */
  conversationId: string;
  /** Delivery state per recipient uid. `deliveryState` is the weakest of these. */
  recipients?: Record<string, DeliveryState>;
}

interface MessageRow {
  message_id: string;
  client_message_id: string;
  sender_id: string;
  text_cipher: string;
  client_created_at: number;
  message_type: string;
  transport: string;
  delivery_state: string;
  read_at: number | null;
  conversation_id?: string;
  recips?: string | null;
  /** Encrypted JSON: reply reference and file description. */
  extra_cipher?: string | null;
}

interface OutboxDbRow {
  message_id: string;
  recipient_id: string;
  payload_cipher: string;
  created_at: number;
  attempt_count: number;
  last_attempt_at: number | null;
  delivery_state: string;
  last_error: string | null;
}

interface BrowserState {
  messages: MessageRow[];
  outbox: OutboxDbRow[];
  meta: Record<string, string>;
}

const BROWSER_KEY = 'duochat.dev-store.v1';
const MAX_MESSAGES = 2000;
const FILES_DB = 'privcord-files';
const FILES_STORE = 'files';

function emptyBrowserState(): BrowserState {
  return { messages: [], outbox: [], meta: {} };
}

function parseRecips(raw: string | null | undefined): Record<string, DeliveryState> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, DeliveryState>;
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(row: MessageRow): Omit<StoredMessage, 'text'> & {
  textCipher: string;
} {
  return {
    conversationId: row.conversation_id ?? '',
    recipients: parseRecips(row.recips),
    messageId: row.message_id,
    clientMessageId: row.client_message_id,
    senderId: row.sender_id,
    clientCreatedAt: row.client_created_at,
    type: row.message_type === 'file' ? 'file' : 'text',
    transport: row.transport === 'relay' ? 'relay' : 'p2p',
    deliveryState: row.delivery_state as DeliveryState,
    readAt: row.read_at,
    textCipher: row.text_cipher,
  };
}

export class LocalStore {
  /** Browser storage only: the packaged app runs the Rust engine, which keeps its own encrypted database. */
  backend: 'browser' = 'browser';
  initError: string | null = null;
  private cipher: TextCipher | null = null;

  setCipher(cipher: TextCipher): void {
    this.cipher = cipher;
  }

  private async encrypt(text: string): Promise<string> {
    if (!this.cipher) throw new Error('Local store cipher is not initialized.');
    return this.cipher.encrypt(text);
  }

  private async decrypt(payload: string): Promise<string> {
    if (!this.cipher) throw new Error('Local store cipher is not initialized.');
    return this.cipher.decrypt(payload);
  }

  async init(): Promise<void> {
    this.backend = 'browser';
    if (!localStorage.getItem(BROWSER_KEY)) {
      this.writeBrowser(emptyBrowserState());
    }
  }

  private readBrowser(): BrowserState {
    try {
      const raw = localStorage.getItem(BROWSER_KEY);
      if (!raw) return emptyBrowserState();
      const parsed = JSON.parse(raw) as Partial<BrowserState>;
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
      };
    } catch {
      return emptyBrowserState();
    }
  }

  private writeBrowser(state: BrowserState): void {
    localStorage.setItem(BROWSER_KEY, JSON.stringify(state));
  }

  async loadMessages(limit = MAX_MESSAGES): Promise<StoredMessage[]> {
    let rows: MessageRow[] = [];
    rows = this.readBrowser().messages
      .slice()
      .sort((a, b) =>
        a.client_created_at === b.client_created_at
          ? a.message_id < b.message_id
            ? -1
            : 1
          : a.client_created_at - b.client_created_at,
      )
      .slice(-limit);
  
    const messages: StoredMessage[] = [];
    for (const row of rows) {
      const base = rowToMessage(row);
      const { textCipher, ...rest } = base;
      let extra: { replyTo?: ReplyRef; file?: FileMeta; senderName?: string; reactions?: Record<string, string>; deleted?: boolean } = {};
      try {
        if (row.extra_cipher) extra = JSON.parse(await this.decrypt(row.extra_cipher)) as typeof extra;
      } catch {
        extra = {};
      }
      try {
        messages.push({ ...rest, ...extra, text: await this.decrypt(textCipher) });
      } catch {
        messages.push({ ...rest, ...extra, text: '[unable to decrypt locally stored message]' });
      }
    }
    return messages;
  }

  private async toRow(message: StoredMessage): Promise<MessageRow> {
    return {
      conversation_id: message.conversationId,
      recips: message.recipients ? JSON.stringify(message.recipients) : null,
      message_id: message.messageId,
      client_message_id: message.clientMessageId,
      sender_id: message.senderId,
      text_cipher: await this.encrypt(message.text),
      client_created_at: message.clientCreatedAt,
      message_type: message.type,
      transport: message.transport,
      delivery_state: message.deliveryState,
      read_at: message.readAt ?? null,
      extra_cipher:
        message.replyTo || message.file || message.senderName || message.reactions || message.deleted
          ? await this.encrypt(
              JSON.stringify({
                replyTo: message.replyTo,
                file: message.file,
                senderName: message.senderName,
                reactions: message.reactions && Object.keys(message.reactions).length ? message.reactions : undefined,
                deleted: message.deleted || undefined,
              }),
            )
          : null,
    };
  }

  async putMessage(message: StoredMessage): Promise<void> {
    const row = await this.toRow(message);
    const state = this.readBrowser();
    const index = state.messages.findIndex((m) => m.message_id === row.message_id);
    if (index >= 0) state.messages[index] = row;
    else state.messages.push(row);
    if (state.messages.length > MAX_MESSAGES) {
      state.messages = state.messages
        .sort((a, b) => a.client_created_at - b.client_created_at)
        .slice(-MAX_MESSAGES);
    }
    this.writeBrowser(state);
  }

  async updateMessage(
    messageId: string,
    patch: {
      deliveryState?: DeliveryState;
      transport?: 'p2p' | 'relay';
      readAt?: number | null;
      conversationId?: string;
      recipients?: Record<string, DeliveryState>;
    },
  ): Promise<void> {
    const state = this.readBrowser();
    const row = state.messages.find((m) => m.message_id === messageId);
    if (!row) return;
    if (patch.deliveryState !== undefined) row.delivery_state = patch.deliveryState;
    if (patch.transport !== undefined) row.transport = patch.transport;
    if (patch.readAt !== undefined) row.read_at = patch.readAt;
    if (patch.conversationId !== undefined) row.conversation_id = patch.conversationId;
    if (patch.recipients !== undefined) row.recips = JSON.stringify(patch.recipients);
    this.writeBrowser(state);
  }

  /** Small encrypted JSON blobs (contacts, groups): names and membership are private. */
  async getSecret<T>(key: string): Promise<T | null> {
    const raw = await this.getMeta(`secret.${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(await this.decrypt(raw)) as T;
    } catch {
      return null;
    }
  }

  async setSecret(key: string, value: unknown): Promise<void> {
    await this.setMeta(`secret.${key}`, await this.encrypt(JSON.stringify(value)));
  }

  async loadOutbox(): Promise<OutboxRow[]> {
    let rows: OutboxDbRow[] = [];
    rows = this.readBrowser().outbox.slice();
  
    const out: OutboxRow[] = [];
    for (const row of rows) {
      let payload = '';
      try {
        payload = await this.decrypt(row.payload_cipher);
      } catch {
        payload = '';
      }
      out.push({
        messageId: row.message_id,
        recipientId: row.recipient_id,
        payload,
        createdAt: row.created_at,
        attemptCount: row.attempt_count,
        lastAttemptAt: row.last_attempt_at,
        deliveryState: row.delivery_state as DeliveryState,
        lastError: row.last_error,
      });
    }
    return out;
  }

  async enqueueOutbox(row: OutboxRow): Promise<void> {
    const payloadCipher = await this.encrypt(row.payload);
    const state = this.readBrowser();
    const dbRow: OutboxDbRow = {
      message_id: row.messageId,
      recipient_id: row.recipientId,
      payload_cipher: payloadCipher,
      created_at: row.createdAt,
      attempt_count: row.attemptCount,
      last_attempt_at: row.lastAttemptAt,
      delivery_state: row.deliveryState,
      last_error: row.lastError,
    };
    const index = state.outbox.findIndex((r) => r.message_id === row.messageId);
    if (index >= 0) state.outbox[index] = dbRow;
    else state.outbox.push(dbRow);
    this.writeBrowser(state);
  }

  async updateOutbox(
    messageId: string,
    patch: Partial<Pick<OutboxRow, 'attemptCount' | 'lastAttemptAt' | 'deliveryState' | 'lastError'>>,
  ): Promise<void> {
    const state = this.readBrowser();
    const row = state.outbox.find((r) => r.message_id === messageId);
    if (!row) return;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.lastAttemptAt !== undefined) row.last_attempt_at = patch.lastAttemptAt;
    if (patch.deliveryState !== undefined) row.delivery_state = patch.deliveryState;
    if (patch.lastError !== undefined) row.last_error = patch.lastError;
    this.writeBrowser(state);
  }

  async removeOutbox(messageId: string): Promise<void> {
    const state = this.readBrowser();
    state.outbox = state.outbox.filter((r) => r.message_id !== messageId);
    this.writeBrowser(state);
  }

  async getMeta(key: string): Promise<string | null> {
    return this.readBrowser().meta[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const state = this.readBrowser();
    state.meta[key] = value;
    this.writeBrowser(state);
  }

  async clearAll(): Promise<void> {
    this.writeBrowser(emptyBrowserState());
    await this.clearFiles();
  }

  /**
   * Per-conversation clear (kill switch Option A): remove every message and
   * queued delivery, keep other local state. Component metadata survives so
   * a new conversation continues to function.
   */
  async deleteMessage(messageId: string): Promise<void> {
    const state = this.readBrowser();
    state.messages = state.messages.filter((m) => m.message_id !== messageId);
    this.writeBrowser(state);
  
    await this.deleteFile(messageId).catch(() => undefined);
  }

  async clearMessages(): Promise<void> {
    const state = this.readBrowser();
    state.messages = [];
    state.outbox = [];
    this.writeBrowser(state);
    await this.clearFiles();
  }

  /**
   * Kill switch schema erase: also drop the table structure so the local
   * database retains nothing app-specific. The next app start recreates the
   * schema. In browser development mode the whole store is replaced.
   */
  async destroySchema(): Promise<void> {
    this.writeBrowser(emptyBrowserState());
    await this.clearFiles();
  }

  /* ---------------- files (IndexedDB, encrypted with the same local key) ---------------- */

  private filesDb: Promise<IDBDatabase> | null = null;

  private openFiles(): Promise<IDBDatabase> {
    this.filesDb ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(FILES_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(FILES_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open the file store.'));
    });
    return this.filesDb;
  }

  private async fileTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.openFiles();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, mode);
      const req = run(tx.objectStore(FILES_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('File store error.'));
      tx.onabort = () => reject(tx.error ?? new Error('File store error.'));
    });
  }

  async putFile(messageId: string, bytes: Uint8Array): Promise<void> {
    if (!this.cipher) throw new Error('Local store cipher is not initialized.');
    const sealed = await this.cipher.encryptBytes(bytes);
    await this.fileTx('readwrite', (s) => s.put(sealed, messageId));
  }

  async getFile(messageId: string): Promise<Uint8Array | null> {
    if (!this.cipher) throw new Error('Local store cipher is not initialized.');
    const sealed = await this.fileTx<Uint8Array | undefined>('readonly', (s) => s.get(messageId));
    return sealed ? this.cipher.decryptBytes(sealed) : null;
  }

  async deleteFile(messageId: string): Promise<void> {
    await this.fileTx('readwrite', (s) => s.delete(messageId));
  }

  async clearFiles(): Promise<void> {
    try {
      await this.fileTx('readwrite', (s) => s.clear());
    } catch {
      // No IndexedDB (or never opened): nothing to clear.
    }
  }
}
