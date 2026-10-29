import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { ChatEngine, type ChatState } from '../lib/engine';
import { LocalStore } from '../lib/localDb';
import { createTextCipher } from '../lib/encryption';
import { notifyIncoming } from '../lib/notifications';
import { config } from '../config';
import type { MessageMode } from '../lib/settings';

export interface UseChatEngine {
  state: ChatState | null;
  engine: ChatEngine | null;
  fatal: string | null;
}

export function useChatEngine(
  user: User,
  peerUid: string,
  messageMode: MessageMode,
): UseChatEngine {
  const [state, setState] = useState<ChatState | null>(null);
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const modeRef = useRef(messageMode);
  modeRef.current = messageMode;

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
        messageMode: modeRef.current,
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

  useEffect(() => {
    engine?.setMessageMode(messageMode);
  }, [engine, messageMode]);

  return { state, engine, fatal };
}
