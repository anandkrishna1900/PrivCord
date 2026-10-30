export const CONNECTION_MODES = [
  'P2P_CONNECTED',
  'CONNECTING',
  'RECONNECTING',
  'OFFLINE_QUEUED',
  'CONNECTION_FAILED',
] as const;

export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export interface ConnectionInputs {
  p2pConnected: boolean;
  connecting?: boolean;
  reconnecting?: boolean;
  failed?: boolean;
  queuedMessages?: number;
}

export function deriveConnectionMode(input: ConnectionInputs): ConnectionMode {
  if (input.p2pConnected) return 'P2P_CONNECTED';
  if (input.connecting) return 'CONNECTING';
  if (input.reconnecting) return 'RECONNECTING';
  if (input.failed) return 'CONNECTION_FAILED';
  return 'OFFLINE_QUEUED';
}

export interface ConnectionPresentation {
  label: string;
  detail: string;
  tone: 'online' | 'direct' | 'busy' | 'offline' | 'error';
  p2p: boolean;
}

export function presentConnection(
  mode: ConnectionMode,
  queuedMessages = 0,
): ConnectionPresentation {
  switch (mode) {
    case 'P2P_CONNECTED':
      return {
        label: 'Direct',
        detail: 'Connected straight to the other device. Messages never touch a server.',
        tone: 'direct',
        p2p: true,
      };
    case 'CONNECTING':
      return {
        label: 'Connecting',
        detail: 'Establishing a direct connection to the other device.',
        tone: 'busy',
        p2p: false,
      };
    case 'RECONNECTING':
      return {
        label: 'Reconnecting',
        detail: 'Connection lost. Exchange a new connection code to reconnect.',
        tone: 'busy',
        p2p: false,
      };
    case 'CONNECTION_FAILED':
      return {
        label: 'Connection failed',
        detail: 'The direct connection could not be established. Messages stay queued on this device.',
        tone: 'error',
        p2p: false,
      };
    case 'OFFLINE_QUEUED':
    default:
      return {
        label: queuedMessages > 0 ? `Not connected · ${queuedMessages} queued` : 'Not connected',
        detail:
          'No direct connection. Messages are saved locally and sent once you connect.',
        tone: 'offline',
        p2p: false,
      };
  }
}
