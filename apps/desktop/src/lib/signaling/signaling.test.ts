import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveIdentityFromPhrase,
  generateRecoveryPhrase,
  mailboxFor,
  open,
  seal,
  uidFromDh,
  type SealedBlob,
} from '@duochat/protocol';
// The real self-hosted relay, so the client is tested against the actual wire protocol.
// @ts-expect-error plain JS module without types
import { startRelay } from '../../../../../relay/server.js';
import { SignalingHub } from './hub';
import { makeEvent, verifyEvent } from './nostr';
import { RelayClient } from './relayClient';

async function person() {
  const { identity } = await deriveIdentityFromPhrase(generateRecoveryPhrase());
  return { identity, uid: await uidFromDh(identity.dhKey.pubJwk) };
}

async function sealTo(a: Awaited<ReturnType<typeof person>>, b: Awaited<ReturnType<typeof person>>, payload: unknown) {
  return seal({
    payload,
    fromUid: a.uid,
    toUid: b.uid,
    toDh: b.identity.dhKey.pubJwk,
    signPriv: a.identity.signKey.privJwk,
  });
}

function waitFor<T>(register: (resolve: (v: T) => void) => void, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    register((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

describe('self-hosted relay client against the real relay', () => {
  let relay: { port: number; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await relay?.close();
    relay = null;
  });

  it('delivers a sealed offer end to end and only the recipient can open it', async () => {
    relay = await startRelay({ port: 0, dataDir: '/tmp/claude-0/relay-test-' + Math.random().toString(36).slice(2), allowStoreForward: false });
    const url = `ws://127.0.0.1:${relay!.port}`;
    const a = await person();
    const b = await person();
    const boxB = await mailboxFor(b.uid);

    const listener = new RelayClient(url);
    const received = waitFor<SealedBlob>((resolve) => listener.start(boxB, (blob) => resolve(blob)));
    await waitFor<void>((resolve) => {
      const iv = setInterval(() => {
        if (listener.status() === 'online') {
          clearInterval(iv);
          resolve();
        }
      }, 20);
    });

    const hub = new SignalingHub([new RelayClient(url)]);
    hub.start(await mailboxFor(a.uid), () => undefined);
    await new Promise((r) => setTimeout(r, 150));
    await hub.put(boxB, await sealTo(a, b, { t: 'offer', sdp: 'v=0 secret-sdp' }), { kind: 'sig', ttlSec: 60 });

    const blob = await received;
    expect(JSON.stringify(blob)).not.toContain('secret-sdp');
    const opened = await open({
      blob,
      ownUid: b.uid,
      ownDhPriv: b.identity.dhKey.privJwk,
      senderSign: a.identity.signKey.pubJwk,
      senderUid: a.uid,
    });
    expect(opened).toEqual({ t: 'offer', sdp: 'v=0 secret-sdp' });
    listener.stop();
    hub.stop();
  });

  it('reports an error when the relay is unreachable', async () => {
    const hub = new SignalingHub([new RelayClient('ws://127.0.0.1:1')]);
    hub.start('x', () => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.status()).not.toBe('online');
    await expect(hub.put('x', {} as SealedBlob, { kind: 'sig', ttlSec: 5 })).rejects.toThrow();
    hub.stop();
  });
});

describe('nostr events', () => {
  it('are valid signed events addressed to a mailbox and unlinkable between sends', async () => {
    const a = await person();
    const b = await person();
    const blob = await sealTo(a, b, { t: 'ready' });
    const e1 = makeEvent('mailbox-1', blob, { kind: 'sig', ttlSec: 60 }, 1_000);
    const e2 = makeEvent('mailbox-1', blob, { kind: 'msg', ttlSec: 3600 }, 1_000);
    expect(verifyEvent(e1)).toBe(true);
    expect(e1.tags).toContainEqual(['t', 'mailbox-1']);
    expect(e1.tags).toContainEqual(['expiration', '1060']);
    expect(e1.kind).toBe(21733);
    expect(e2.kind).toBe(31733);
    expect(e1.pubkey).not.toBe(e2.pubkey);
    expect(verifyEvent({ ...e1, content: e1.content + 'x' })).toBe(false);
    expect(verifyEvent({ ...e1, sig: e2.sig })).toBe(false);
  });
});
