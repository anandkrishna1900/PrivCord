import { useEffect, useRef, useState } from 'react';
import type { DeliveryState } from '@duochat/protocol';
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
} from './Icons';

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
  messages,
  isGroup,
  empty,
  onRetry,
}: {
  messages: UiMessage[];
  isGroup: boolean;
  empty: string;
  onRetry: (messageId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const didInitialScroll = useRef(false);
  const lastIdRef = useRef<string | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  async function handleCopy(text: string) {
    const copied = await copyText(text);
    setCopyStatus(copied ? 'copied' : 'failed');
    window.setTimeout(() => setCopyStatus(null), 1800);
  }

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const last = messages[messages.length - 1];
    const sentNew = last?.own && last.messageId !== lastIdRef.current;
    lastIdRef.current = last?.messageId;
    if (!didInitialScroll.current || atBottomRef.current || sentNew) {
      element.scrollTop = element.scrollHeight;
      didInitialScroll.current = true;
    }
  }, [messages]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    atBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
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
    <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="message-inner">
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
            <div key={message.messageId}>
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
                >
                  {!own && isGroup && !grouped ? (
                    <span className="bubble-sender">{message.senderName}</span>
                  ) : null}
                  <p className="bubble-text">{message.text}</p>
                  <span className="bubble-meta">
                    <button
                      type="button"
                      className="bubble-copy"
                      onClick={() => void handleCopy(message.text)}
                      title="Copy message"
                      aria-label="Copy message"
                    >
                      <CopyIcon size={12} />
                    </button>
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
