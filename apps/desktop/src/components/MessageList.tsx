import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, DeliveryState } from '@duochat/protocol';
import { formatDay, formatTime } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { Avatar } from './Avatar';
import {
  AlertIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ShieldIcon,
} from './Icons';

function DeliveryIndicator({
  state,
  onRetry,
}: {
  state: DeliveryState;
  onRetry: () => void;
}) {
  const titles: Record<DeliveryState, string> = {
    QUEUED: 'Queued locally',
    SENT: 'Accepted by transport',
    DELIVERED: 'Delivered to the other device',
    READ: 'Read by your friend',
    FAILED: 'Delivery failed — click to retry',
  };
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
  selfUid,
  peerName,
  onRetry,
  peerDirect,
  paired,
}: {
  messages: ChatMessage[];
  selfUid: string;
  peerName: string;
  onRetry: (messageId: string) => void;
  peerDirect: boolean;
  paired: boolean;
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
    const sentNew = last?.senderId === selfUid && last.messageId !== lastIdRef.current;
    lastIdRef.current = last?.messageId;
    if (!didInitialScroll.current || atBottomRef.current || sentNew) {
      element.scrollTop = element.scrollHeight;
      didInitialScroll.current = true;
    }
  }, [messages, selfUid]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    atBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  }

  if (messages.length === 0) {
    return (
      <div className="message-scroll empty" ref={scrollRef}>
        <div className="empty-state">
          <div className="empty-emblem">
            <ShieldIcon size={30} />
          </div>
          <h2>Your private conversation starts here</h2>
          <p>
            Messages are stored only on this device and sent straight to your
            friend over an encrypted direct connection. No account, no server.
          </p>
          <span className="empty-hint">
            {peerDirect
              ? 'Connected directly.'
              : paired
                ? 'Not connected. Messages you write are queued and sent when you reconnect.'
                : 'Use the key button above to pair with your friend.'}
          </span>
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
          const own = message.senderId === selfUid;
          const grouped =
            !showDay &&
            lastSender === message.senderId &&
            message.clientCreatedAt - lastTimestamp < 4 * 60_000;
          lastSender = message.senderId;
          lastTimestamp = message.clientCreatedAt;
          const showAvatar =
            !own && (!grouped || index === messages.length - 1);
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
                {!own ? (
                  <span className="message-avatar-slot">
                    {showAvatar ? <Avatar name={peerName} size={28} /> : null}
                  </span>
                ) : null}
                <div
                  className={`bubble ${own ? 'own' : 'theirs'}`}
                  title={new Date(message.clientCreatedAt).toISOString()}
                >
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
                        state={message.deliveryState}
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
