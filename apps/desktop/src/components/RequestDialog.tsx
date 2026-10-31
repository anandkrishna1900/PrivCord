import { useState } from 'react';
import type { ChatEngine, InviteRequest } from '../lib/engine';
import { Modal } from './Modal';
import { CheckIcon, ShieldIcon } from './Icons';

/** Somebody typed our six words and answered: we confirm who it is before adding them. */
export function RequestDialog({
  requests,
  engine,
  onAdded,
}: {
  requests: InviteRequest[];
  engine: ChatEngine | null;
  onAdded: (uid: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const request = requests[0];
  if (!request || !engine) return null;

  return (
    <Modal open onClose={() => engine.dismissRequest(request.uid)} title={`${request.name} used your invite`}>
      <div className="verify-panel">
        <ShieldIcon size={22} />
        <h3>Add {request.name}?</h3>
        <p className="muted">
          Only add them if you expected this. To be sure it is really them, read these numbers to {request.name} on a
          call or in person; they should see the same ones.
        </p>
        <code className="safety-number selectable">{request.safetyNumber}</code>
        {error ? (
          <p className="status-text error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <button
            type="button"
            className="button primary"
            onClick={() =>
              void engine
                .acceptRequest(request.uid)
                .then((uid) => onAdded(uid))
                .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not add them.'))
            }
          >
            <CheckIcon size={16} />
            Add {request.name}
          </button>
          <button type="button" className="button ghost" onClick={() => engine.dismissRequest(request.uid)}>
            Not them
          </button>
        </div>
      </div>
    </Modal>
  );
}
