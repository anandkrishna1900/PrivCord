import {
  canonicalJson,
  ecdsaSign,
  ecdsaVerify,
  fromB64Url,
  sha256,
  toB64Url,
  verifyIdentityProof,
  type PrivateJwk,
  type PublicJwk,
} from '../e2ee';
import { uidFromDh, type ContactCard } from '../connectivity/contactCard';

/**
 * A group is nothing but a signed, causally ordered log of membership events.
 * Every member holds the same log, so every member derives the same roster
 * (see `GroupLog`). There is no group server and no shared group key: messages
 * are sent to each member over that member's own authenticated channel.
 */
export type GroupEventType = 'create' | 'add' | 'remove' | 'rename';

export interface GroupEvent {
  v: 1;
  kind: 'group_event';
  /** SHA-256 (hex) of the canonical unsigned body. For `create` it is also the group id. */
  eventId: string;
  groupId: string;
  type: GroupEventType;
  /** uid of the author. */
  actor: string;
  /** Author's clock; informational only, never used for ordering. */
  ts: number;
  /** Event ids the author had already seen (its heads). Gives causal order without clocks. */
  deps: string[];
  /** `add` / `remove`: the member concerned. */
  target?: string;
  /** `create`: the author's own card. `add`: the new member's card (this is the introduction). */
  card?: ContactCard;
  /** `create` / `rename`. */
  name?: string;
  /** ECDSA signature by the actor's identity signing key over the canonical unsigned body. */
  sig: string;
}

export type UnsignedGroupEvent = Omit<GroupEvent, 'eventId' | 'sig'>;

const enc = new TextEncoder();

export const MAX_GROUP_NAME = 60;

function body(e: UnsignedGroupEvent): string {
  return canonicalJson({
    v: e.v,
    kind: e.kind,
    groupId: e.groupId,
    type: e.type,
    actor: e.actor,
    ts: e.ts,
    deps: [...e.deps].sort(),
    target: e.target,
    card: e.card ? { v: 1, sign: e.card.sign, dh: e.card.dh, proof: e.card.proof, name: e.card.name } : undefined,
    name: e.name,
  });
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function computeEventId(e: UnsignedGroupEvent): Promise<string> {
  return hex(await sha256(enc.encode(body(e))));
}

/** Build and sign an event. For `create`, pass `groupId: ''`; it becomes the event id. */
export async function signGroupEvent(
  input: Omit<UnsignedGroupEvent, 'v' | 'kind' | 'ts' | 'deps'> & { ts?: number; deps?: string[] },
  signPriv: PrivateJwk,
): Promise<GroupEvent> {
  const unsigned: UnsignedGroupEvent = {
    v: 1,
    kind: 'group_event',
    groupId: input.groupId,
    type: input.type,
    actor: input.actor,
    ts: input.ts ?? Date.now(),
    deps: [...(input.deps ?? [])].sort(),
    target: input.target,
    card: input.card,
    name: input.name,
  };
  if (unsigned.type === 'create') return signCreate({ ...unsigned, groupId: '' }, signPriv);
  const eventId = await computeEventId(unsigned);
  const sig = toB64Url(await ecdsaSign(signPriv, enc.encode(body(unsigned))));
  return { ...unsigned, eventId, sig };
}

/** `create` is special: groupId = eventId, so the id is computed over the body with an empty group id. */
async function signCreate(withEmpty: UnsignedGroupEvent, signPriv: PrivateJwk): Promise<GroupEvent> {
  const eventId = await computeEventId(withEmpty);
  const unsigned = withEmpty;
  const finalBody: UnsignedGroupEvent = { ...unsigned, groupId: eventId };
  const sig = toB64Url(await ecdsaSign(signPriv, enc.encode(body(finalBody) + '|' + eventId)));
  return { ...finalBody, eventId, sig };
}

/** What the signature covers (create events bind the id into the signed text). */
function signedText(e: GroupEvent): Uint8Array {
  const unsigned: UnsignedGroupEvent = {
    v: e.v, kind: e.kind, groupId: e.groupId, type: e.type, actor: e.actor, ts: e.ts, deps: e.deps,
    target: e.target, card: e.card, name: e.name,
  };
  return enc.encode(e.type === 'create' ? body(unsigned) + '|' + e.eventId : body(unsigned));
}

export function isGroupEventShape(value: unknown): value is GroupEvent {
  const e = value as GroupEvent | null;
  if (typeof e !== 'object' || e === null || e.v !== 1 || e.kind !== 'group_event') return false;
  if (typeof e.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(e.eventId)) return false;
  if (typeof e.groupId !== 'string' || typeof e.actor !== 'string' || e.actor.length === 0) return false;
  if (!['create', 'add', 'remove', 'rename'].includes(e.type)) return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (!Array.isArray(e.deps) || e.deps.length > 64 || e.deps.some((d) => typeof d !== 'string')) return false;
  if (e.target !== undefined && typeof e.target !== 'string') return false;
  if (e.name !== undefined && (typeof e.name !== 'string' || e.name.length === 0 || e.name.length > MAX_GROUP_NAME)) return false;
  if (typeof e.sig !== 'string') return false;
  if ((e.type === 'add' || e.type === 'remove') && !e.target) return false;
  if ((e.type === 'create' || e.type === 'add') && !e.card) return false;
  if ((e.type === 'create' || e.type === 'rename') && !e.name) return false;
  return true;
}

/** Recompute the id; for `create` the group id must equal the event id. */
export async function eventIdMatches(e: GroupEvent): Promise<boolean> {
  const unsigned: UnsignedGroupEvent = {
    v: e.v, kind: e.kind, groupId: e.type === 'create' ? '' : e.groupId, type: e.type, actor: e.actor, ts: e.ts,
    deps: e.deps, target: e.target, card: e.card, name: e.name,
  };
  const id = await computeEventId(unsigned);
  return id === e.eventId && (e.type !== 'create' || e.groupId === id);
}

export async function cardIsValid(card: ContactCard | undefined, expectedUid: string): Promise<boolean> {
  if (!card) return false;
  try {
    if (!(await verifyIdentityProof(card.sign, card.dh, card.proof))) return false;
    return (await uidFromDh(card.dh)) === expectedUid;
  } catch {
    return false;
  }
}

export async function signatureValid(e: GroupEvent, signer: PublicJwk): Promise<boolean> {
  try {
    return await ecdsaVerify(signer, fromB64Url(e.sig), signedText(e));
  } catch {
    return false;
  }
}
