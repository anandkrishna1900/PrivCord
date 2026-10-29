import { useEffect, useRef } from 'react';
import type { ChatMessage, DeliveryState } from '@duochat/protocol';
import { formatDay, formatTime } from '../lib/format';
import { Avatar } from './Avatar';
import {
  AlertIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  LoaderIcon,
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
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  peerDirect,
}: {
  messages: ChatMessage[];
  selfUid: string;
  peerName: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (messageId: string) => void;
  peerDirect: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const didInitialScroll = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!didInitialScroll.current || atBottomRef.current) {
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
        <div className="empty-state">
          <div className="empty-emblem">
            <ShieldIcon size={30} />
          </div>
          <h2>Your private conversation starts here</h2>
          <p>
            Only the two approved accounts can read this thread. Messages are
            stored locally and synchronized through the cloud when it is
            available.
          </p>
          <span className="empty-hint">
            {peerDirect
              ? 'A direct peer channel is connected.'
              : 'Send a message — it will queue safely if the network is down.'}
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
      {hasOlder ? (
        <div className="older-row">
          <button
            type="button"
            className="button ghost small"
            onClick={onLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? <LoaderIcon size={14} className="spin" /> : null}
            {loadingOlder ? 'Loading…' : 'Load earlier messages'}
          </button>
        </div>
      ) : null}

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
    </div>
  );
}
