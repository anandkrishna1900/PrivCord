import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_LENGTH,
  createOutgoingMessage,
  createPeerMessageFrame,
  fromCloudMessage,
  parsePeerMessageFrame,
  toCloudMessagePayload,
  validateOutgoingText,
} from '../src';

const sender = 'uid-a';

describe('message validation', () => {
  it('accepts normal text and normalizes CRLF', () => {
    const result = validateOutgoingText('hello\r\nworld');
    expect(result).toEqual({ ok: true, value: 'hello\nworld' });
  });

  it('rejects blank text, non-strings, and overlong text', () => {
    expect(validateOutgoingText('   ').ok).toBe(false);
    expect(validateOutgoingText(42 as unknown as string).ok).toBe(false);
    expect(validateOutgoingText('a'.repeat(MAX_TEXT_LENGTH + 1)).ok).toBe(false);
  });

  it('counts Unicode code points rather than UTF-16 units', () => {
    const emoji = '😀'.repeat(MAX_TEXT_LENGTH);
    expect(validateOutgoingText(emoji).ok).toBe(true);
  });

  it('creates a queued message with stable identifiers', () => {
    const message = createOutgoingMessage({ senderId: sender, text: 'hi', now: 1000 });
    expect(message.messageId).toBe(message.clientMessageId);
    expect(message.deliveryState).toBe('QUEUED');
    expect(message.syncedToCloud).toBe(false);
    expect(message.clientCreatedAt).toBe(1000);
  });

  it('rejects messages without a sender', () => {
    expect(() =>
      createOutgoingMessage({ senderId: '', text: 'hi' }),
    ).toThrow(/sender/i);
  });
});

describe('cloud payloads', () => {
  it('round-trips a message through the cloud representation', () => {
    const message = createOutgoingMessage({
      senderId: sender,
      text: 'cloud hello',
      now: 2000,
    });
    const payload = toCloudMessagePayload(message);
    const decoded = fromCloudMessage(message.messageId, {
      ...payload,
      createdAt: { toMillis: () => 2500 },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.text).toBe('cloud hello');
    expect(decoded.value.syncedToCloud).toBe(true);
    expect(decoded.value.serverCreatedAt).toBe(2500);
  });

  it('rejects a mismatched document id and bad fields', () => {
    expect(
      fromCloudMessage('a', {
        messageId: 'b',
        senderId: sender,
        text: 'x',
        type: 'text',
        clientMessageId: 'b',
        clientCreatedAt: 1,
        transport: 'cloud',
      }).ok,
    ).toBe(false);
    expect(
      fromCloudMessage('a', {
        messageId: 'a',
        senderId: sender,
        text: '',
        type: 'text',
        clientMessageId: 'a',
        clientCreatedAt: 1,
        transport: 'cloud',
      }).ok,
    ).toBe(false);
  });
});

describe('peer frames', () => {
  it('round-trips a text frame', () => {
    const message = createOutgoingMessage({
      senderId: sender,
      text: 'direct',
      now: 3000,
      transport: 'p2p',
    });
    const parsed = parsePeerMessageFrame(
      JSON.parse(JSON.stringify(createPeerMessageFrame(message))),
    );
    expect(parsed?.text).toBe('direct');
    expect(parsed?.transport).toBe('p2p');
    expect(parsed?.syncedToCloud).toBe(false);
  });

  it('drops malformed or spoofed frames', () => {
    expect(parsePeerMessageFrame(null)).toBeNull();
    expect(
      parsePeerMessageFrame({
        v: 1,
        kind: 'message',
        messageId: 'm',
        clientMessageId: 'm',
        senderId: sender,
        text: '',
        clientCreatedAt: 1,
      }),
    ).toBeNull();
  });
});
