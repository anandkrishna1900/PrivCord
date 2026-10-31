import { PROTOCOL_VERSION } from './constants';
import { isRecord, validateClientMessageId } from './message';

/*
 * Small social features that travel over an already-authenticated link:
 *  - delete for everyone: the sender asks the others to remove one of the sender's own messages;
 *  - reactions: one emoji per person per message;
 *
 * None of this can be enforced against a modified app: a receiver who wants to keep a message can. The apps say so.
 */

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

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
