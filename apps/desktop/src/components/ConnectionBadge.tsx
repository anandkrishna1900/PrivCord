import {
  presentConnection,
  type ConnectionMode,
} from '@duochat/protocol';
import { AlertIcon, LinkIcon, WifiOffIcon } from './Icons';

export function ConnectionBadge({
  mode,
  queuedMessages,
  compact = false,
}: {
  mode: ConnectionMode;
  queuedMessages: number;
  compact?: boolean;
}) {
  const presentation = presentConnection(mode, queuedMessages);
  return (
    <span
      className={`connection-badge tone-${presentation.tone}`}
      title={presentation.detail}
    >
      <span className="connection-dot" />
      {compact ? null : <span>{presentation.label}</span>}
      {!compact && presentation.p2p ? <LinkIcon size={13} /> : null}
      {!compact && !presentation.p2p ? (
        presentation.tone === 'error' ? <AlertIcon size={13} /> : <WifiOffIcon size={13} />
      ) : null}
    </span>
  );
}
