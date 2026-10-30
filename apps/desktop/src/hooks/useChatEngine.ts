import { useEffect, useState } from 'react';
import { ChatEngine, type ChatState } from '../lib/engine';
import { LOCAL_ID, loadIdentity } from '../lib/identity';
import { LocalStore } from '../lib/localDb';
import { createTextCipher } from '../lib/encryption';
import { notifyIncoming } from '../lib/notifications';
import { config } from '../config';

export interface UseChatEngine {
  state: ChatState | null;
  engine: ChatEngine | null;
  fatal: string | null;
  /** First run: no identity yet, so the 12-word phrase flow must run first. */
  needsIdentity: boolean;
  /** Call after an identity was created or restored. */
  reload: () => void;
}

export function useChatEngine(): UseChatEngine {
  const [state, setState] = useState<ChatState | null>(null);
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [needsIdentity, setNeedsIdentity] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let created: ChatEngine | undefined;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const store = new LocalStore();
      store.setCipher(await createTextCipher(LOCAL_ID));
      const identity = await loadIdentity();
      if (cancelled) return;
      setNeedsIdentity(identity === null);
      if (!identity) return;
      const chatEngine = new ChatEngine({
        identity,
        context: config.conversationId,
        store,
        onNotify: (message, title) => void notifyIncoming(message, title),
      });
      created = chatEngine;
      setEngine(chatEngine);
      unsubscribe = chatEngine.subscribe(setState);
      await chatEngine.start();
    })().catch((error) => {
      if (!cancelled) setFatal(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      created?.stop();
      setEngine(null);
      setState(null);
    };
  }, [version]);

  return { state, engine, fatal, needsIdentity, reload: () => setVersion((v) => v + 1) };
}
