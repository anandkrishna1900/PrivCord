/**
 * Turns the Rust engine's snapshot (as JSON) into the `ChatState` the screens already read. This is the desktop's version
 * of what `RustChatEngine.publish` does on Android. It is a pure function so it is tested without Tauri.
 */
import {
  BLUETOOTH_PATH,
  MAX_GROUP_MEMBERS,
  classifyPath,
  diagnoseConnection,
  summarizeReactions,
  type ConnectionPath,
  type DeliveryState,
} from '@duochat/protocol';
import type {
  ChannelView,
  ChatState,
  ConnState,
  ContactView,
  GroupView,
  InviteRequest,
  LastMessage,
  MemberView,
  UiMessage,
} from '../engine';
import type { StoredMessage } from '../localDb';
import type { SignalingStatus } from '../signaling/types';

/* ---- the engine's JSON (serde output of the FFI types) ---- */

export type LinkStateJson =
  | 'Offline'
  | 'Connecting'
  | { Connected: { path: PathKindJson } }
  | { Reconnecting: { attempt: number } }
  | { Failed: { authentication: boolean } };
export type PathKindJson = 'DirectLan' | 'DirectNat' | 'Relayed' | 'Bluetooth' | 'Unknown';
export type DeliveryJson = 'Queued' | 'Sent' | 'Delivered' | 'Read' | 'Failed';

export interface ContactJson {
  uid: string;
  name: string | null;
  display_name: string;
  introduced_by: string | null;
  verified: boolean;
  checked: boolean;
  safety_number: string;
  link: LinkStateJson;
  can_message: boolean;
}

export interface MessageJson {
  id: string;
  sender: string;
  text: string;
  created_at: number;
  delivery: DeliveryJson;
  reply_to: string | null;
  is_file: boolean;
  file_mime: string;
  file_size: number;
  deleted: boolean;
  reactions: { emoji: string; count: number; mine: boolean }[];
  pending: number;
  total: number;
}

export interface ConversationJson {
  id: string;
  messages: MessageJson[];
  last: { text: string; at: number; own: boolean; sender: string } | null;
  unread: number;
}

export interface GroupJson {
  id: string;
  name: string;
  created_by: string;
  members: { uid: string; admin: boolean }[];
  am_admin: boolean;
  full: boolean;
  max_members: number;
  connected: number;
}

export interface SnapshotJson {
  seq: number;
  own_uid: string | null;
  contacts: ContactJson[];
  conversations: ConversationJson[];
  groups: GroupJson[];
  channels: string[];
  muted: string[];
  invite: { words: string; expires_at: number } | null;
  requests: { uid: string; name: string; safety_number: string }[];
  answer: { uid: string; status: 'Sent' | 'Failed' } | null;
  lookup_pending: boolean;
  queued: number;
  channel_people: { uid: string; name: string }[];
}

/* ---- what the page knows that the engine does not ---- */

export interface LinkFacts {
  attempts: number;
  sawPeerReply: boolean;
  localCandidates: { host: number; srflx: number; relay: number } | null;
  iceState: string | null;
}

export interface ShapeContext {
  ownName: string;
  signaling: SignalingStatus;
  signalingConfigured: boolean;
  hasTurn: boolean;
  storeForward: boolean;
  /** Which kind of link is carrying a connected friend (default: WebRTC). */
  via: (uid: string) => 'webrtc' | 'ble' | null;
  facts: (uid: string) => LinkFacts | undefined;
  /** 0..1 for files being sent or received, by message id. */
  progress: ReadonlyMap<string, number>;
  /** Files that have started to arrive but are not whole yet (shown with a progress bar). */
  incoming: ReadonlyMap<string, { conversation: string; sender: string; name: string; size: number; since: number }>;
  phase: ChatState['phase'];
  error: string | null;
  notice: string | null;
}

const DELIVERY: Record<DeliveryJson, DeliveryState> = {
  Queued: 'QUEUED',
  Sent: 'SENT',
  Delivered: 'DELIVERED',
  Read: 'READ',
  Failed: 'FAILED',
};

const short = (uid: string) => uid.slice(0, 6);

export function pathOf(kind: PathKindJson): ConnectionPath {
  switch (kind) {
    case 'DirectLan':
      return classifyPath('host', 'host');
    case 'DirectNat':
      return classifyPath('srflx', 'srflx');
    case 'Relayed':
      return classifyPath('relay', 'host');
    case 'Bluetooth':
      return BLUETOOTH_PATH;
    default:
      return classifyPath('unknown', 'unknown');
  }
}

export function connOf(link: LinkStateJson): ConnState {
  if (link === 'Offline') return 'offline';
  if (link === 'Connecting') return 'connecting';
  if (typeof link === 'object' && 'Connected' in link) return 'connected';
  if (typeof link === 'object' && 'Reconnecting' in link) return 'connecting';
  return 'offline';
}

export function shapeState(s: SnapshotJson, ctx: ShapeContext): ChatState {
  const me = s.own_uid ?? '';
  const people = new Map(s.channel_people.map((p) => [p.uid, p.name]));
  const contactBy = new Map(s.contacts.map((c) => [c.uid, c]));
  const muted = new Set(s.muted);

  const nameOf = (uid: string): string => {
    if (uid === me) return 'You';
    const c = contactBy.get(uid);
    if (c) return c.display_name;
    for (const g of s.groups) if (g.members.some((m) => m.uid === uid)) return people.get(uid) ?? `Friend ${short(uid)}`;
    return people.get(uid) ?? `Friend ${short(uid)}`;
  };
  // A person we only know from a channel: the name they chose plus a short id, so two "Alex" can be told apart.
  const channelLabel = (uid: string): string =>
    `${uid === me ? ctx.ownName || 'Anonymous' : (people.get(uid) ?? 'Anonymous')} #${uid.slice(0, 4)}`;

  const convBy = new Map(s.conversations.map((c) => [c.id, c]));
  const lastOf = (id: string): LastMessage | undefined => {
    const l = convBy.get(id)?.last;
    if (!l) return undefined;
    const isChannel = id.startsWith('chan:');
    if (isChannel && muted.has(l.sender)) return undefined;
    return {
      text: l.text,
      at: l.at,
      own: l.own,
      ...(isChannel ? { senderName: channelLabel(l.sender) } : id !== l.sender ? { senderName: nameOf(l.sender) } : {}),
    };
  };
  const unreadOf = (id: string) => convBy.get(id)?.unread ?? 0;

  const online = ctx.signaling === 'online';
  const statusFor = (c: ContactJson): string => {
    const conn = connOf(c.link);
    if (conn === 'connected') {
      const path = typeof c.link === 'object' && 'Connected' in c.link ? pathOf(c.link.Connected.path) : null;
      return path ? `Connected · ${path.label}` : 'Connected';
    }
    if (conn === 'connecting') return 'Connecting…';
    if (online) return `Waiting for ${c.display_name} to come online`;
    return ctx.signalingConfigured ? 'Not connected' : 'Not connected · no connection service is set up';
  };

  const contacts: ContactView[] = s.contacts.map((c) => {
    const conn = connOf(c.link);
    const facts = ctx.facts(c.uid);
    const diagnosis =
      conn !== 'connected' && facts
        ? diagnoseConnection(
            {
              signaling: ctx.signaling,
              attempts: facts.attempts,
              sawPeerReply: facts.sawPeerReply,
              localCandidates: facts.localCandidates,
              iceState: facts.iceState,
              hasTurn: ctx.hasTurn,
              storeForward: ctx.storeForward,
            },
            c.display_name,
          )
        : null;
    return {
      uid: c.uid,
      name: c.display_name,
      trust: c.verified ? 'verified' : 'introduced',
      checked: c.checked,
      introducedBy: c.introduced_by ?? undefined,
      introducedByName: c.introduced_by ? nameOf(c.introduced_by) : undefined,
      conn,
      path: typeof c.link === 'object' && 'Connected' in c.link ? pathOf(c.link.Connected.path) : null,
      via: conn === 'connected' ? (ctx.via(c.uid) ?? 'webrtc') : null,
      unread: unreadOf(c.uid),
      last: lastOf(c.uid),
      status: statusFor(c),
      ...(diagnosis ? { diagnosis } : {}),
      direct: c.can_message,
    };
  });

  const groups: GroupView[] = s.groups.map((g) => {
    const isMember = g.members.some((m) => m.uid === me);
    const members: MemberView[] = g.members.map((m) => {
      const c = contactBy.get(m.uid);
      return {
        uid: m.uid,
        name: nameOf(m.uid),
        role: m.admin ? 'admin' : 'member',
        isMe: m.uid === me,
        addedBy: '',
        addedByName: '',
        conn: m.uid === me ? 'connected' : c ? connOf(c.link) : 'offline',
        introducedHere: !!c?.introduced_by,
        canMessage: !!c?.can_message,
      };
    });
    return {
      groupId: g.id,
      name: g.name,
      status: isMember ? 'member' : 'removed',
      members,
      amAdmin: g.am_admin,
      full: g.full || g.members.length >= (g.max_members || MAX_GROUP_MEMBERS),
      maxMembers: g.max_members || MAX_GROUP_MEMBERS,
      connected: g.connected,
      unread: unreadOf(g.id),
      last: lastOf(g.id),
    };
  });

  const messages: Record<string, UiMessage[]> = {};
  for (const conv of s.conversations) {
    const isChannel = conv.id.startsWith('chan:');
    const visible = isChannel ? conv.messages.filter((m) => !muted.has(m.sender)) : conv.messages;
    const unreadFrom = visible.length - conv.unread;
    messages[conv.id] = visible.map((m, index) => {
      const own = m.sender === me;
      const reactions: Record<string, string> = {};
      // The engine reports chips (emoji, count, mine); the screens only need them back as chips.
      for (const chip of m.reactions) {
        if (chip.mine) reactions[me] = chip.emoji;
        for (let i = 0; i < chip.count - (chip.mine ? 1 : 0); i += 1) reactions[`r:${chip.emoji}:${i}`] = chip.emoji;
      }
      const replied = m.reply_to ? conv.messages.find((r) => r.id === m.reply_to) : undefined;
      const stored: StoredMessage = {
        messageId: m.id,
        clientMessageId: m.id,
        senderId: m.sender,
        text: m.text,
        clientCreatedAt: m.created_at,
        type: m.is_file ? 'file' : 'text',
        transport: 'p2p',
        deliveryState: DELIVERY[m.delivery],
        readAt: own || index < unreadFrom ? 1 : null,
        conversationId: conv.id,
        ...(m.reply_to ? { replyTo: { id: m.reply_to, author: replied?.sender ?? '', preview: replied?.text ?? '' } } : {}),
        ...(m.is_file ? { file: { name: m.text, mime: m.file_mime, size: m.file_size, sha256: '' } } : {}),
        ...(isChannel ? { senderName: channelLabel(m.sender) } : {}),
        ...(m.deleted ? { deleted: true } : {}),
        reactions,
      };
      const progress = ctx.progress.get(m.id);
      return {
        ...stored,
        own,
        senderName: stored.senderName ?? nameOf(m.sender),
        tick: DELIVERY[m.delivery],
        delivered: Math.max(0, m.total - m.pending),
        total: m.total,
        reactionChips: m.reactions.length ? m.reactions.map((c) => ({ ...c })) : summarizeReactions(reactions, me),
        ...(progress !== undefined ? { progress } : {}),
      };
    });
  }

  // Files still arriving: a bubble per file with its progress bar, replaced by the real message when it is whole.
  for (const [id, f] of ctx.incoming) {
    const have = messages[f.conversation] ?? [];
    if (have.some((m) => m.messageId === id)) continue;
    const sender = f.conversation.startsWith('chan:') ? f.sender : f.conversation;
    (messages[f.conversation] ??= []).push({
      messageId: id,
      clientMessageId: id,
      senderId: sender,
      text: f.name,
      clientCreatedAt: f.since,
      type: 'file',
      transport: 'p2p',
      deliveryState: 'DELIVERED',
      readAt: null,
      conversationId: f.conversation,
      file: { name: f.name, mime: 'application/octet-stream', size: f.size, sha256: '' },
      own: false,
      senderName: nameOf(sender),
      tick: 'DELIVERED',
      delivered: 0,
      total: 0,
      reactionChips: [],
      progress: ctx.progress.get(id) ?? 0,
    });
  }

  const requests: InviteRequest[] = s.requests.map((r) => ({
    uid: r.uid,
    name: r.name || `Friend ${short(r.uid)}`,
    safetyNumber: r.safety_number,
  }));
  const channels: ChannelView[] = s.channels.map((name) => ({
    id: `chan:${name}`,
    name,
    unread: unreadOf(`chan:${name}`),
    last: lastOf(`chan:${name}`),
    conn: online ? 'connected' : 'connecting',
  }));

  return {
    channels,
    answer: s.answer
      ? {
          uid: s.answer.uid,
          name: nameOf(s.answer.uid),
          status: s.answer.status === 'Sent' ? 'sent' : 'failed',
          ...(s.answer.status === 'Failed' ? { error: 'Could not reach them.' } : {}),
        }
      : null,
    invite: s.invite ? { words: s.invite.words, expiresAt: s.invite.expires_at } : null,
    requests,
    phase: ctx.phase,
    uid: me,
    contacts,
    groups,
    messages,
    signaling: ctx.signaling,
    storageBackend: 'sqlite',
    queued: s.queued,
    error: ctx.error,
    notice: ctx.notice,
  };
}
