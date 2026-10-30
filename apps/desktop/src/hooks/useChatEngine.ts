import { useEffect, useRef, useState } from 'react';
import { ChatEngine, type ChatState } from '../lib/engine';
import { LOCAL_ID, loadOrCreateIdentity } from '../lib/identity';
import { LocalStore } from '../lib/localDb';
import { createTextCipher } from '../lib/encryption';
import { notifyIncoming } from '../lib/notifications';
import { config } from '../config';

export interface UseChatEngine {
  state: ChatState | null;
  engine: ChatEngine | null;
  fatal: string | null;
}

export function useChatEngine(peerName: string): UseChatEngine {
  const [state, setState] = useState<ChatState | null>(null);
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const nameRef = useRef(peerName);
  nameRef.current = peerName;

  useEffect(() => {
    let cancelled = false;
    let created: ChatEngine | undefined;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const store = new LocalStore();
      store.setCipher(await createTextCipher(LOCAL_ID));
      const identity = await loadOrCreateIdentity();
      if (cancelled) return;
      const chatEngine = new ChatEngine({
        identity,
        conversationId: config.conversationId,
        store,
        onNotify: (message) => void notifyIncoming(message, nameRef.current),
      });
      created = chatEngine;
      setEngine(chatEngine);
      unsubscribe = chatEngine.subscribe(setState);
      await chatEngine.start();
    })().catch((error) => {
      if (!cancelled) {
        setFatal(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      created?.stop();
      setEngine(null);
      setState(null);
    };
  }, []);

  return { state, engine, fatal };
}
