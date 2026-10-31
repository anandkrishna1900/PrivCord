import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatBytes, isInlineImage, isInlineVideo, type DeliveryState } from '@duochat/protocol';
import type { FileMeta } from '../lib/localDb';
import type { UiMessage } from '../lib/engine';
import { formatDay, formatTime } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { Avatar } from './Avatar';
import {
  AlertIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  ReplyIcon,
} from './Icons';

type LoadFile = (messageId: string) => Promise<{ blob: Blob; meta: FileMeta } | null>;

/** A received or sent file: a preview for safe image types, a card with Save for everything else. */
function FileBubble({ message, loadFile }: { message: UiMessage; loadFile: LoadFile }) {
  const meta = message.file;
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const isImage = !!meta && isInlineImage(meta.mime);
  const isVideo = !!meta && isInlineVideo(meta.mime);
  const preview = isImage || isVideo;

  useEffect(() => {
    if (!preview) return;
    let revoked = false;
    let made: string | null = null;
    void loadFile(message.messageId).then((f) => {
      if (revoked) return;
      if (!f) {
        setMissing(true);
        return;
      }
      made = URL.createObjectURL(f.blob);
      setUrl(made);
    });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [message.messageId, preview, loadFile]);

  async function save() {
    const f = await loadFile(message.messageId);
    if (!f) {
      setMissing(true);
      return;
    }
    // Saved as an opaque download: nothing is ever opened or run by the app.
    const href = URL.createObjectURL(new Blob([f.blob], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = f.meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  if (!meta) return <p className="bubble-text">{message.text}</p>;
  return (
    <div className="file-bubble">
      {isImage && url ? (
        <button type="button" className="file-image-button" onClick={() => setViewing(true)} aria-label={`Open ${meta.name}`}>
          <img className="file-image" src={url} alt={meta.name} />
        </button>
      ) : null}
      {viewing && url ? (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={meta.name} onClick={() => setViewing(false)}>
          <img className="lightbox-image" src={url} alt={meta.name} />
          <div className="lightbox-bar" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="button secondary small" onClick={() => void save()}>
              <DownloadIcon size={15} />
              Save
            </button>
            <button type="button" className="button ghost small" onClick={() => setViewing(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
      {isVideo && url ? <video className="file-video" src={url} controls preload="metadata" playsInline /> : null}
      <div className="file-card">
        <span className="file-icon" aria-hidden="true">
          <FileIcon size={22} />
        </span>
        <span className="file-info">
          <strong className="file-name">{meta.name}</strong>
          <span className="small file-size">
            {missing ? 'No longer stored on this device' : formatBytes(meta.size)}
          </span>
        </span>
        {!missing ? (
          <button type="button" className="icon-button subtle" onClick={() => void save()} aria-label={`Save ${meta.name}`} title="Save">
            <DownloadIcon size={17} />
          </button>
        ) : null}
      </div>
      {message.progress !== undefined ? (
        <div className="file-progress" role="progressbar" aria-valuenow={Math.round(message.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.round(message.progress * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function DeliveryIndicator({
  state,
  onRetry,
  detail,
}: {
  state: DeliveryState;
  onRetry: () => void;
  detail?: string;
}) {
  const titles: Record<DeliveryState, string> = {
    QUEUED: 'Waiting to send',
    SENT: 'Sent',
    DELIVERED: 'Delivered',
    READ: 'Read',
    FAILED: "Couldn't send. Click to try again",
  };
  if (detail) titles[state] = `${titles[state]} · ${detail}`;
  if (state === 'FAILED') {
    return (
      <button
        type="button"
        className="delivery-indicator failed"
        onClick={onRetry}
        title={titles[state]}
        aria-label={titles[state]}
      >
        <AlertIcon size={13} />
      </button>
    );
  }
  const icon =
    state === 'QUEUED' ? (
      <ClockIcon size={13} />
    ) : state === 'SENT' ? (
      <CheckIcon size={13} />
    ) : (
      <CheckCheckIcon size={14} className={state === 'READ' ? 'read' : undefined} />
    );
  return (
    <span className="delivery-indicator" title={titles[state]} aria-label={titles[state]}>
      {icon}
    </span>
  );
}

export function MessageList({
  convId,
  messages,
  isGroup,
  empty,
  onRetry,
  onReply,
  loadFile,
  canReply = true,
  onMute,
}: {
  convId: string;
  messages: UiMessage[];
  isGroup: boolean;
  empty: string;
  onRetry: (messageId: string) => void;
  onReply: (message: UiMessage) => void;
  loadFile: LoadFile;
  /** Channels have no replies (the quote has nowhere to travel). */
  canReply?: boolean;
  /** Channels: hide one person's messages. */
  onMute?: (uid: string) => void;
}) {
  const [muteOffer, setMuteOffer] = useState<string | null>(null);
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  function jumpTo(id: string) {
    const el = scrollRef.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  /** True while the view follows the newest message. Scrolling up by hand turns it off; reaching the bottom turns it on. */
  const pinnedRef = useRef(true);
  const lastIdRef = useRef<string | undefined>(undefined);
  const [unseen, setUnseen] = useState(0);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  async function handleCopy(text: string) {
    const copied = await copyText(text);
    setCopyStatus(copied ? 'copied' : 'failed');
    window.setTimeout(() => setCopyStatus(null), 1800);
  }

  function toBottom(behavior: ScrollBehavior = 'auto') {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior });
  }

  // A new conversation opens at the newest message.
  useLayoutEffect(() => {
    pinnedRef.current = true;
    lastIdRef.current = undefined;
    setUnseen(0);
    toBottom();
  }, [convId]);

  // New messages: follow them while pinned (or when we sent it); otherwise count them for the jump button.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    const isNew = !!last && last.messageId !== lastIdRef.current;
    const hadAny = lastIdRef.current !== undefined;
    lastIdRef.current = last?.messageId;
    if (!isNew) return;
    if (pinnedRef.current || last.own || !hadAny) {
      pinnedRef.current = true;
      toBottom();
    } else if (!last.own) {
      setUnseen((n) => n + 1);
    }
  }, [messages]);

  // Photos, videos and quotes change height after they appear: keep following the bottom while pinned.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom();
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [messages.length === 0]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 40) {
      pinnedRef.current = true;
      setUnseen(0);
    } else if (distance > 120) {
      pinnedRef.current = false;
    }
  }

  // Reading older messages must not be undone by a message arriving at the same moment.
  function onWheel(event: React.WheelEvent) {
    if (event.deltaY < 0) pinnedRef.current = false;
  }

  if (messages.length === 0) {
    return (
      <div className="message-scroll empty" ref={scrollRef}>
        <div className="empty-state small">
          <p>{empty}</p>
        </div>
      </div>
    );
  }

  let lastDay = '';
  let lastSender: string | null = null;
  let lastTimestamp = 0;

  return (
    <div className="message-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel} onTouchMove={() => { if (scrollRef.current && scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight > 120) pinnedRef.current = false; }}>
      <div className="message-inner" ref={innerRef}>
        {messages.map((message, index) => {
          const day = formatDay(message.clientCreatedAt);
          const showDay = day !== lastDay;
          if (showDay) lastDay = day;
          const own = message.own;
          const grouped =
            !showDay &&
            lastSender === message.senderId &&
            message.clientCreatedAt - lastTimestamp < 4 * 60_000;
          lastSender = message.senderId;
          lastTimestamp = message.clientCreatedAt;
          const showAvatar =
            !own && !grouped;
          return (
            <div key={message.messageId} data-mid={message.messageId}>
              {showDay ? (
                <div className="day-separator">
                  <span>{day}</span>
                </div>
              ) : null}
              <div
                className={`message-row ${own ? 'own' : 'theirs'} ${
                  grouped ? 'grouped' : ''
                }`}
              >
                {!own && isGroup ? (
                  <span className="message-avatar-slot">
                    {showAvatar ? <Avatar name={message.senderName} size={28} /> : null}
                  </span>
                ) : null}
                <div
                  className={`bubble ${own ? 'own' : 'theirs'}`}
                  title={new Date(message.clientCreatedAt).toISOString()}
                  onContextMenu={(event) => {
                    // Right-click replies (the touch-screen equivalent of press and hold).
                    if (!canReply) return;
                    event.preventDefault();
                    onReply(message);
                  }}
                >
                  {!own && isGroup && !grouped ? (
                    onMute ? (
                      <span className="bubble-sender">
                        <button type="button" className="sender-button" onClick={() => setMuteOffer(muteOffer === message.messageId ? null : message.messageId)}>
                          {message.senderName}
                        </button>
                        {muteOffer === message.messageId ? (
                          <button type="button" className="chip chip-button" onClick={() => { onMute(message.senderId); setMuteOffer(null); }}>
                            Mute this person
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="bubble-sender">{message.senderName}</span>
                    )
                  ) : null}
                  {message.replyTo ? (
                    <button type="button" className="quote" onClick={() => jumpTo(message.replyTo!.id)} title="Go to the original message">
                      <strong>{message.replyTo.author === message.senderId ? message.senderName : byId.get(message.replyTo.id)?.senderName ?? 'Earlier message'}</strong>
                      <span>{message.replyTo.preview}</span>
                    </button>
                  ) : null}
                  {message.type === 'file' ? (
                    <FileBubble message={message} loadFile={loadFile} />
                  ) : (
                    <p className="bubble-text">{message.text}</p>
                  )}
                  <span className="bubble-meta">
                    {canReply ? (
                      <button
                        type="button"
                        className="bubble-copy"
                        onClick={() => onReply(message)}
                        title="Reply"
                        aria-label="Reply to this message"
                      >
                        <ReplyIcon size={12} />
                      </button>
                    ) : null}
                    {message.type === 'text' ? (
                      <button
                        type="button"
                        className="bubble-copy"
                        onClick={() => void handleCopy(message.text)}
                        title="Copy message"
                        aria-label="Copy message"
                      >
                        <CopyIcon size={12} />
                      </button>
                    ) : null}
                    <span className="bubble-time">{formatTime(message.clientCreatedAt)}</span>
                    {own ? (
                      <DeliveryIndicator
                        state={message.tick}
                        detail={isGroup && message.total > 1 ? `${message.delivered} of ${message.total}` : undefined}
                        onRetry={() => onRetry(message.messageId)}
                      />
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            pinnedRef.current = true;
            setUnseen(0);
            toBottom('smooth');
          }}
        >
          ↓ {unseen} new {unseen === 1 ? 'message' : 'messages'}
        </button>
      ) : null}
      {copyStatus ? (
        <div
          className={`copy-toast ${copyStatus === 'failed' ? 'error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {copyStatus === 'copied' ? 'Message copied' : 'Could not copy message'}
        </div>
      ) : null}
    </div>
  );
}
