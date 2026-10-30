import { useEffect, useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react';
import { MAX_TEXT_LENGTH, countCodePoints, FileTransferManager, type FileMetadata } from '@duochat/protocol';
import { SendIcon } from './Icons';

export function Composer({
  onSend,
  onSendFile,
  disabled,
  connected,
}: {
  onSend: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSendFile?: (file: File) => Promise<void>;
  disabled: boolean;
  connected: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

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
    if (!text.trim() || overLimit || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await submit();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setSending(true);
      if (onSendFile) {
        await onSendFile(file);
      } else {
        // Fallback: send as metadata representation
        await onSend(`[Attachment: ${file.name} (${(file.size / 1024).toFixed(1)} KB)]`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'File transfer failed');
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="composer-wrapper">
      {error ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <div className={`composer ${overLimit ? 'over-limit' : ''}`}>
        <button
          type="button"
          className="icon-button attach-button"
          title="Attach encrypted file or image"
          disabled={disabled || sending}
          onClick={() => fileInputRef.current?.click()}
          style={{ marginRight: '4px' }}
        >
          📎
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            connected
              ? 'Write a message… (Enter to send, Shift+Enter for newline)'
              : 'Write a message — it will be queued until connected…'
          }
          disabled={disabled}
          rows={1}
          aria-label="Message text"
        />

        <div className="composer-actions">
          {overLimit ? (
            <span className="char-count danger">
              {length}/{MAX_TEXT_LENGTH}
            </span>
          ) : length > MAX_TEXT_LENGTH * 0.9 ? (
            <span className="char-count warning">
              {length}/{MAX_TEXT_LENGTH}
            </span>
          ) : null}

          <button
            type="button"
            className="send-button"
            onClick={send}
            disabled={disabled || sending || !text.trim() || overLimit}
            aria-label="Send message"
          >
            <SendIcon size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
