import { useEffect, useState } from 'react';
import type { ChatEngine, ChatState, ContactView, GroupView } from '../lib/engine';
import { Modal } from './Modal';
import { Avatar } from './Avatar';
import { MAX_GROUP_MEMBERS } from '@duochat/protocol';
import { CheckIcon, LogOutIcon, UserIcon } from './Icons';

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : 'Something went wrong.';
}

function FriendPicker({
  friends,
  picked,
  onToggle,
  max,
}: {
  friends: ContactView[];
  picked: Set<string>;
  onToggle: (uid: string) => void;
  /** How many more can be picked. */
  max: number;
}) {
  if (friends.length === 0) return <p className="muted small">No friends to choose from yet.</p>;
  return (
    <ul className="pick-list">
      {friends.map((friend) => (
        <li key={friend.uid}>
          <label className="pick-row">
            <input
              type="checkbox"
              checked={picked.has(friend.uid)}
              disabled={!picked.has(friend.uid) && picked.size >= max}
              onChange={() => onToggle(friend.uid)}
            />
            <Avatar name={friend.name} size={32} />
            <span>{friend.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function useToggleSet() {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (uid: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(uid)) next.add(uid);
      return next;
    });
  return { picked, toggle, reset: () => setPicked(new Set()) };
}

export function NewGroupDialog({
  open,
  onClose,
  engine,
  state,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  state: ChatState;
  onCreated: (groupId: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { picked, toggle, reset } = useToggleSet();

  useEffect(() => {
    if (!open) return;
    setName('');
    setError(null);
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function create() {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      const id = await engine.createGroup(name, [...picked]);
      onClose();
      onCreated(id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New group"
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            Create group
          </button>
        </>
      }
    >
      <label className="field">
        <span>Group name</span>
        <input value={name} maxLength={60} placeholder="Weekend trip" onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="field">
        <span>Add friends</span>
        <FriendPicker friends={state.contacts.filter((c) => c.direct)} picked={picked} onToggle={toggle} max={MAX_GROUP_MEMBERS - 1} />
        <p className="muted small">
          Up to {MAX_GROUP_MEMBERS} people per group, including you. Anyone you add can add their own friends, and
          everyone is connected automatically.
        </p>
      </div>
      {error ? (
        <p className="status-text error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function GroupDetailsDialog({
  open,
  onClose,
  engine,
  state,
  group,
  onVerify,
  onMessage,
}: {
  open: boolean;
  onClose: () => void;
  engine: ChatEngine | null;
  state: ChatState;
  group: GroupView | null;
  onVerify: (uid: string) => void;
  onMessage: (uid: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { picked, toggle, reset } = useToggleSet();

  useEffect(() => {
    if (!open) return;
    setAdding(false);
    setError(null);
    setConfirmLeave(false);
    setName(group?.name ?? '');
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group?.groupId]);

  if (!group) return null;
  const active = group.status === 'member';
  const memberIds = new Set(group.members.map((m) => m.uid));
  const addable = state.contacts.filter((c) => c.direct && !memberIds.has(c.uid));
  const room = Math.max(0, group.maxMembers - group.members.length);

  async function run(task: () => Promise<void>) {
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={group.name} eyebrow="Group">
      {active && group.amAdmin ? (
        <div className="field-row">
          <input value={name} maxLength={60} aria-label="Group name" onChange={(event) => setName(event.target.value)} />
          <button
            type="button"
            className="button secondary small"
            disabled={!name.trim() || name.trim() === group.name}
            onClick={() => void run(() => engine!.renameGroup(group.groupId, name))}
          >
            Rename
          </button>
        </div>
      ) : null}
      <h3 className="section-title">
        {group.members.length} of {group.maxMembers} members
      </h3>
      <ul className="member-list">
        {group.members.map((member) => (
          <li key={member.uid} className="member-row">
            <Avatar name={member.name} size={34} online={member.conn === 'connected'} />
            <div className="member-main">
              <strong>
                {member.name}
                {member.isMe ? '' : member.role === 'admin' ? ' · admin' : ''}
              </strong>
              <span className="muted small">
                {member.isMe
                  ? member.role === 'admin' ? 'You · admin' : 'You'
                  : `Added by ${member.addedByName}`}
                {!member.isMe && member.conn !== 'connected' ? ' · not connected yet' : ''}
              </span>
            </div>
            {!member.isMe && !member.canMessage ? (
              <span className="chip" title="You can talk in this group. One of you stays group-only, so there is no direct chat unless you swap invites.">
                Group only
              </span>
            ) : null}
            {!member.isMe ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => (member.canMessage ? onMessage(member.uid) : onVerify(member.uid))}
              >
                {member.canMessage ? 'Message' : 'Details'}
              </button>
            ) : null}
            {active && group.amAdmin && !member.isMe ? (
              <button
                type="button"
                className="button ghost small danger"
                onClick={() => void run(() => engine!.removeGroupMember(group.groupId, member.uid))}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {active ? (
        adding ? (
          <div className="field">
            <span>Add from your friends</span>
            <FriendPicker friends={addable} picked={picked} onToggle={toggle} max={room} />
            <div className="button-row">
              <button
                type="button"
                className="button primary small"
                disabled={picked.size === 0}
                onClick={() =>
                  void run(async () => {
                    for (const uid of picked) await engine!.addGroupMember(group.groupId, uid);
                    reset();
                    setAdding(false);
                  })
                }
              >
                <CheckIcon size={15} />
                Add {picked.size || ''}
              </button>
              <button type="button" className="button ghost small" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button type="button" className="button secondary" disabled={addable.length === 0 || group.full} onClick={() => setAdding(true)}>
              <UserIcon size={16} />
              Add member
            </button>
            {group.full ? (
              <span className="muted small">This group is full ({group.maxMembers} people is the limit).</span>
            ) : addable.length === 0 ? (
              <span className="muted small">
                {state.contacts.some((c) => !c.direct) ? 'Group-only people cannot be added from here.' : 'All your friends are already here.'}
              </span>
            ) : null}
          </div>
        )
      ) : (
        <p className="muted small">{group.status === 'removed' ? 'You were removed from this group.' : 'You left this group.'}</p>
      )}

      {error ? (
        <p className="status-text error" role="alert">
          {error}
        </p>
      ) : null}

      {active ? (
        <div className="danger-zone">
          {confirmLeave ? (
            <div className="button-row">
              <button
                type="button"
                className="button danger"
                onClick={() =>
                  void run(async () => {
                    await engine!.leaveGroup(group.groupId);
                    onClose();
                  })
                }
              >
                Yes, leave group
              </button>
              <button type="button" className="button ghost" onClick={() => setConfirmLeave(false)}>
                Stay
              </button>
            </div>
          ) : (
            <button type="button" className="button danger ghost" onClick={() => setConfirmLeave(true)}>
              <LogOutIcon size={16} />
              Leave group
            </button>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
