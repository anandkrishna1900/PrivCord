import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { MAX_TEXT_LENGTH, countCodePoints } from '@duochat/protocol';
import { MicIcon, PaperclipIcon, SendIcon, XIcon } from './Icons';

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
  const recorder = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const recordStop = useRef<number | undefined>(undefined);
  const cancelled = useRef(false);
  const [recording, setRecording] = useState(0);
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

  /** Voice note: record from the microphone, send as a small audio file when stopped. */
  async function toggleRecording(cancel = false) {
    if (recorder.current) {
      cancelled.current = cancel;
      recorder.current.stop();
      return;
    }
    if (disabled || uploading) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recordChunks.current = [];
      cancelled.current = false;
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) recordChunks.current.push(event.data);
      };
      const started = Date.now();
      const tick = window.setInterval(() => setRecording(Math.floor((Date.now() - started) / 1000)), 500);
      rec.onstop = () => {
        window.clearInterval(tick);
        window.clearTimeout(recordStop.current);
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        setRecording(0);
        if (cancelled.current || recordChunks.current.length === 0) return;
        // "audio/webm;codecs=opus" -> "audio/webm": the codec note is not part of the type we send.
        const type = (rec.mimeType || 'audio/webm').split(';')[0]!.trim();
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        void sendFiles([new File(recordChunks.current, `voice-note.${ext}`, { type })]);
      };
      recorder.current = rec;
      rec.start();
      setRecording(1);
      // Five minutes is plenty for a voice note and keeps the file well under the size limit.
      recordStop.current = window.setTimeout(() => recorder.current?.stop(), 5 * 60_000);
    } catch {
      setError('Could not use the microphone. Allow microphone access for PrivCord and try again.');
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
        {isChannel ? null : (
          <button
            type="button"
            className={`icon-button attach-button mic-button ${recording ? 'recording' : ''}`}
            onClick={() => void toggleRecording()}
            disabled={disabled || uploading}
            aria-label={recording ? 'Stop and send the voice note' : 'Record a voice note'}
            title={recording ? `Recording ${recording}s. Click to send` : 'Record a voice note'}
          >
            <MicIcon size={18} />
          </button>
        )}
        {recording ? (
          <button type="button" className="icon-button attach-button" onClick={() => void toggleRecording(true)} aria-label="Cancel the voice note" title="Cancel">
            <XIcon size={16} />
          </button>
        ) : null}
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
