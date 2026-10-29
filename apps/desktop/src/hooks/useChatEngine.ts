import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { ChatEngine, type ChatState } from '../lib/engine';
import { LocalStore } from '../lib/localDb';
import { createTextCipher } from '../lib/encryption';
import { notifyIncoming } from '../lib/notifications';
import { config } from '../config';

export interface UseChatEngine {
  state: ChatState | null;
  engine: ChatEngine | null;
  fatal: string | null;
}

export function useChatEngine(user: User, peerUid: string): UseChatEngine {
  const [state, setState] = useState<ChatState | null>(null);
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: ChatEngine | undefined;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const store = new LocalStore();
      const cipher = await createTextCipher(user.uid);
      store.setCipher(cipher);
      const chatEngine = new ChatEngine({
        uid: user.uid,
        peerUid,
        conversationId: config.conversationId,
        email: user.email ?? '',
        displayName: user.displayName ?? '',
        store,
        onNotify: (message) => {
          const name =
            created?.getState().peerProfile?.displayName ?? 'your friend';
          void notifyIncoming(message, name);
        },
      });
      created = chatEngine;
      if (cancelled) {
        chatEngine.stop();
        return;
      }
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
  }, [user.uid, user.email, user.displayName, peerUid]);

  return { state, engine, fatal };
}
