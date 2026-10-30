export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export type ConnectionPath =
  | { kind: 'direct-lan'; label: string; detail: string }
  | { kind: 'direct-nat'; label: string; detail: string }
  | { kind: 'relayed'; label: string; detail: string }
  | { kind: 'unknown'; label: string; detail: string };

/** Classify the *selected* ICE candidate pair. Never inferred from configuration. */
export function classifyPath(local: CandidateType, remote: CandidateType): ConnectionPath {
  if (local === 'unknown' || remote === 'unknown') {
    return { kind: 'unknown', label: 'Unknown path', detail: 'The browser did not report the selected connection path.' };
  }
  if (local === 'relay' || remote === 'relay') {
    return {
      kind: 'relayed',
      label: 'Relayed through TURN',
      detail: 'Traffic passes through a TURN server. It is still end-to-end encrypted, but it is not a direct connection.',
    };
  }
  if (local === 'host' && remote === 'host') {
    return { kind: 'direct-lan', label: 'Direct, same network', detail: 'Connected straight to the other device on the same network.' };
  }
  return {
    kind: 'direct-nat',
    label: 'Direct, peer to peer',
    detail: 'Connected straight to the other device across the internet (NAT traversed). No server carries your messages.',
  };
}

interface StatsLike {
  forEach(cb: (value: Record<string, unknown>) => void): void;
}

/** Pull the selected candidate pair out of RTCPeerConnection.getStats(). */
export function selectedPairFromStats(stats: StatsLike): { local: CandidateType; remote: CandidateType } | null {
  const byId = new Map<string, Record<string, unknown>>();
  let selectedPairId: string | null = null;
  stats.forEach((report) => {
    byId.set(String(report.id), report);
    if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
      selectedPairId = report.selectedCandidatePairId;
    }
  });
  let pair = selectedPairId ? byId.get(selectedPairId) : undefined;
  if (!pair) {
    for (const report of byId.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated === true || report.selected === true)) {
        pair = report;
        break;
      }
    }
  }
  if (!pair) return null;
  const type = (id: unknown): CandidateType => {
    const t = byId.get(String(id))?.candidateType;
    return t === 'host' || t === 'srflx' || t === 'prflx' || t === 'relay' ? t : 'unknown';
  };
  return { local: type(pair.localCandidateId), remote: type(pair.remoteCandidateId) };
}
