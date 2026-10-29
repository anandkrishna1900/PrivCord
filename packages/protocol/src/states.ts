export const CONNECTION_MODES = [
  'CLOUD_CONNECTED',
  'P2P_CONNECTED',
  'CLOUD_AND_P2P_CONNECTED',
  'CONNECTING',
  'RECONNECTING',
  'OFFLINE_QUEUED',
  'CONNECTION_FAILED',
] as const;

export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export interface ConnectionInputs {
  cloudConnected: boolean;
  p2pConnected: boolean;
  connecting?: boolean;
  reconnecting?: boolean;
  failed?: boolean;
  queuedMessages?: number;
}

export function deriveConnectionMode(input: ConnectionInputs): ConnectionMode {
  if (input.cloudConnected && input.p2pConnected) {
    return 'CLOUD_AND_P2P_CONNECTED';
  }
  if (input.cloudConnected) {
    return input.p2pConnected ? 'CLOUD_AND_P2P_CONNECTED' : 'CLOUD_CONNECTED';
  }
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
  cloud: boolean;
  p2p: boolean;
}

export function presentConnection(
  mode: ConnectionMode,
  queuedMessages = 0,
): ConnectionPresentation {
  switch (mode) {
    case 'CLOUD_AND_P2P_CONNECTED':
      return {
        label: 'Cloud + direct',
        detail: 'Cloud sync and a direct peer channel are both active.',
        tone: 'online',
        cloud: true,
        p2p: true,
      };
    case 'CLOUD_CONNECTED':
      return {
        label: 'Cloud',
        detail: 'Messages sync through the cloud. A direct channel is being negotiated.',
        tone: 'online',
        cloud: true,
        p2p: false,
      };
    case 'P2P_CONNECTED':
      return {
        label: 'Direct only',
        detail:
          'Cloud sync is unavailable. Messages travel directly and will sync when the cloud returns.',
        tone: 'direct',
        cloud: false,
        p2p: true,
      };
    case 'CONNECTING':
      return {
        label: 'Connecting',
        detail: 'Establishing a connection to the other device.',
        tone: 'busy',
        cloud: false,
        p2p: false,
      };
    case 'RECONNECTING':
      return {
        label: 'Reconnecting',
        detail: 'Connection lost. Retrying automatically.',
        tone: 'busy',
        cloud: false,
        p2p: false,
      };
    case 'CONNECTION_FAILED':
      return {
        label: 'Connection failed',
        detail:
          'No path is available. Messages stay queued until a connection returns.',
        tone: 'error',
        cloud: false,
        p2p: false,
      };
    case 'OFFLINE_QUEUED':
    default:
      return {
        label: queuedMessages > 0 ? `Offline · ${queuedMessages} queued` : 'Offline',
        detail:
          'No connection. Messages are saved locally and will be sent automatically.',
        tone: 'offline',
        cloud: false,
        p2p: false,
      };
  }
}
