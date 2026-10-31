import { PROTOCOL_VERSION } from './constants';
import { isRecord, validateClientMessageId } from './message';

/*
 * Small social features that travel over an already-authenticated link:
 *  - delete for everyone: the sender asks the others to remove one of the sender's own messages;
 *  - reactions: one emoji per person per message;
 *  - disappearing messages: a sender-chosen lifetime carried on each message (`ttl`, seconds).
 *
 * None of this can be enforced against a modified app: a receiver who wants to keep a message can. The apps say so.
 */

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** Off, one hour, one day, one week. */
export const DISAPPEAR_OPTIONS = [0, 3600, 86_400, 604_800] as const;
export const MAX_DISAPPEAR_SEC = 30 * 86_400;

/** The lifetime in seconds, `undefined` when absent, `null` when present but not allowed. */
export function parseTtl(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DISAPPEAR_SEC) return null;
  return value;
}

export function describeDisappear(sec: number): string {
  if (sec <= 0) return 'Off';
  if (sec % 604_800 === 0) return `${sec / 604_800} week${sec === 604_800 ? '' : 's'}`;
  if (sec % 86_400 === 0) return `${sec / 86_400} day${sec === 86_400 ? '' : 's'}`;
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec === 3600 ? '' : 's'}`;
  return `${sec} seconds`;
}

export interface DeleteFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'delete';
  messageId: string;
}

export interface ReactFrame {
  v: typeof PROTOCOL_VERSION;
  kind: 'react';
  messageId: string;
  emoji: string;
  /** false removes the sender's reaction. */
  on: boolean;
}

export function deleteFrame(messageId: string): DeleteFrame {
  return { v: PROTOCOL_VERSION, kind: 'delete', messageId };
}

export function reactFrame(messageId: string, emoji: string, on: boolean): ReactFrame {
  return { v: PROTOCOL_VERSION, kind: 'react', messageId, emoji, on };
}

export function parseDeleteFrame(value: unknown): DeleteFrame | null {
  if (!isRecord(value) || value.kind !== 'delete' || value.v !== PROTOCOL_VERSION) return null;
  return validateClientMessageId(value.messageId) ? { v: PROTOCOL_VERSION, kind: 'delete', messageId: value.messageId } : null;
}

export function parseReactFrame(value: unknown): ReactFrame | null {
  if (!isRecord(value) || value.kind !== 'react' || value.v !== PROTOCOL_VERSION) return null;
  if (!validateClientMessageId(value.messageId) || typeof value.on !== 'boolean') return null;
  if (typeof value.emoji !== 'string' || !(REACTION_EMOJI as readonly string[]).includes(value.emoji)) return null;
  return { v: PROTOCOL_VERSION, kind: 'react', messageId: value.messageId, emoji: value.emoji, on: value.on };
}

/** Everyone's reactions on one message, ready to show: emoji with a count and whether I reacted. */
export function summarizeReactions(
  reactions: Record<string, string> | undefined,
  me: string,
): { emoji: string; count: number; mine: boolean }[] {
  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const [uid, emoji] of Object.entries(reactions ?? {})) {
    const entry = counts.get(emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    entry.mine ||= uid === me;
    counts.set(emoji, entry);
  }
  return REACTION_EMOJI.filter((e) => counts.has(e)).map((emoji) => ({ emoji, ...counts.get(emoji)! }));
}
