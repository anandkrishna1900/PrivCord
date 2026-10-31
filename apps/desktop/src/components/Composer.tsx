import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { MAX_TEXT_LENGTH, countCodePoints } from '@duochat/protocol';
import { PaperclipIcon, SendIcon, XIcon } from './Icons';

export function Composer({
  onSend,
  disabled,
  placeholder,
  reply,
  onCancelReply,
  onSendFile,
  isChannel = false,
}: {
  /** Public channels carry text only. */
  isChannel?: boolean;
  onSend: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSendFile: (file: File) => Promise<{ ok: true } | { ok: false; error: string }>;
  disabled: boolean;
  placeholder: string;
  reply: { name: string; preview: string } | null;
  onCancelReply: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (event.key === 'Escape' && reply) onCancelReply();
  }

  async function sendFiles(files: File[]) {
    if (disabled || uploading || files.length === 0) return;
    setUploading(true);
    try {
      // One at a time: each goes to every recipient before the next starts.
      for (const file of files.slice(0, 5)) {
        const result = await onSendFile(file);
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      setError(null);
    } finally {
      setUploading(false);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      void sendFiles(files);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void sendFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className={`composer-wrapper ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {reply ? (
        <div className="reply-bar">
          <div className="reply-bar-text">
            <strong>Replying to {reply.name}</strong>
            <span className="muted small">{reply.preview}</span>
          </div>
          <button type="button" className="icon-button subtle" aria-label="Cancel reply" onClick={onCancelReply}>
            <XIcon size={15} />
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="composer-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className={`composer ${overLimit ? 'over-limit' : ''}`}>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Choose files to send"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void sendFiles(files);
          }}
        />
        {isChannel ? null : (
        <button
          type="button"
          className="icon-button attach-button"
          onClick={() => fileInput.current?.click()}
          disabled={disabled || uploading}
          aria-label="Send a file"
          title="Send a file (up to 8 MB)"
        >
          <PaperclipIcon size={18} />
        </button>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
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
