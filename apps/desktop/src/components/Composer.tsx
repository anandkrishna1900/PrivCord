import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_TEXT_LENGTH, countCodePoints } from '@duochat/protocol';
import { SendIcon } from './Icons';

export function Composer({
  onSend,
  disabled,
  connected,
  queued,
}: {
  onSend: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  disabled: boolean;
  connected: boolean;
  queued: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const length = countCodePoints(text);
  const overLimit = length > MAX_TEXT_LENGTH;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  async function submit() {
    if (disabled || sending) return;
    const result = await onSend(text);
    if (result.ok) {
      setText('');
      setError(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      setError(result.error);
    }
  }

  async function send() {
    if (!text.trim() || overLimit) return;
    setSending(true);
    try {
      await submit();
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="composer-shell">
      {error ? (
        <p className="composer-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className={`composer ${overLimit ? 'invalid' : ''}`}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            connected
              ? 'Write a message…'
              : queued
                ? 'Write a message — it will queue until a connection returns…'
                : 'Reconnecting…'
          }
          rows={1}
          maxLength={MAX_TEXT_LENGTH + 200}
          disabled={disabled}
          aria-label="Message"
        />
        <div className="composer-actions">
          {length > MAX_TEXT_LENGTH - 400 ? (
            <span className={`char-count ${overLimit ? 'over' : ''}`}>
              {length.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}
            </span>
          ) : null}
          <button
            type="button"
            className="send-button"
            onClick={() => void send()}
            disabled={disabled || sending || !text.trim() || overLimit}
            aria-label="Send message"
            title="Send (Enter)"
          >
            <SendIcon size={18} />
          </button>
        </div>
      </div>
      <p className="composer-hint">
        Enter sends · Shift + Enter adds a line · Messages stay on this device
        until transport accepts them
      </p>
    </div>
  );
}
