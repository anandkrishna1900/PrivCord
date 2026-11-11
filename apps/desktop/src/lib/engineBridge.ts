/**
 * The page's side of the Rust engine hosted in the Tauri shell (milestone M7, docs/rust/M7_DESKTOP_PLAN.md).
 * Nothing in the app uses it yet: `engine.ts` still runs the app. It exists so the rewire can happen one command at a time.
 *
 * The page keeps owning WebRTC and the relay sockets. It reports what happened to the engine (`link_up`, `frame_received`,
 * `signal_blob`) and does what the engine asks (events `frame`, `close`, `signal-put`, ...), exactly as the Android adapter
 * does. Two lessons from Android are built in: frames reach the engine strictly in order, and a "Busy" answer (the engine's
 * queue is full) is retried instead of dropping the frame.
 */

/** The seam over the Tauri commands and events, so this is testable without a shell. */
export interface EngineBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to an engine-to-page event (`event`, `frame`, `close`, `signal-subscribe`, `signal-put`, `notify`, ...). */
  on(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

export type PathName = 'direct_lan' | 'direct_nat' | 'relayed' | 'bluetooth' | 'unknown';
export type LinkKindName = 'encrypted' | 'open' | 'layered';

const BUSY_RETRY_MS = 5;
const BUSY_GIVE_UP_TRIES = 4000; // about 20 s: the same patience as the Android adapter

const isBusy = (error: unknown) => String(error).includes('Busy');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Typed access to the hosted engine. */
export class HostedEngine {
  /** Everything that flows INTO the engine from the links goes through this one chain, in order. */
  private inbound: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: EngineBridge) {}

  start(): Promise<void> {
    return this.bridge.start();
  }

  stop(): Promise<void> {
    return this.bridge.stop();
  }

  call<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.bridge.invoke(command, args) as Promise<T>;
  }

  /** Queue a call that must stay in order with the other inbound calls, retrying while the engine is busy. */
  private ordered(command: string, args: Record<string, unknown>): Promise<void> {
    const run = async () => {
      for (let tries = 0; ; tries += 1) {
        try {
          await this.bridge.invoke(command, args);
          return;
        } catch (error) {
          if (!isBusy(error) || tries >= BUSY_GIVE_UP_TRIES) throw error;
          await sleep(BUSY_RETRY_MS);
        }
      }
    };
    const next = this.inbound.then(run, run);
    // A failed call must not stop the ones behind it.
    this.inbound = next.catch(() => undefined);
    return next;
  }

  linkUp(peer: string, path: PathName, kind: LinkKindName): Promise<void> {
    return this.ordered('link_up', { peer, path, kind });
  }

  linkDown(peer: string): Promise<void> {
    return this.ordered('link_down', { peer });
  }

  frameReceived(peer: string, frame: string): Promise<void> {
    return this.ordered('frame_received', { peer, frame });
  }

  signalBlob(mailbox: string, blob: string): Promise<void> {
    return this.ordered('signal_blob', { mailbox, blob });
  }

  snapshot<T = unknown>(): Promise<T> {
    return this.call<T>('snapshot');
  }

  sendMessage(peer: string, text: string, replyTo?: string): Promise<string> {
    return this.call<string>('send_message', { peer, text, reply_to: replyTo });
  }

  on(event: string, handler: (payload: unknown) => void): Promise<() => void> {
    return this.bridge.on(event, handler);
  }
}

/** The real bridge: Tauri commands and events. Loaded lazily so unit tests never need the Tauri runtime. */
export async function tauriEngineBridge(): Promise<EngineBridge> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return {
    start: () => invoke('engine_start'),
    stop: () => invoke('engine_stop'),
    invoke: (command, args = {}) => invoke('engine_invoke', { command, args }),
    on: async (event, handler) => listen(`privcord://${event}`, (e) => handler(e.payload)),
  };
}
