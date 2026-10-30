export interface PeerTransportHandlers {
  onOpen: () => void;
  onClose: () => void;
  onFrame: (data: string) => void;
  onStateChange: (state: RTCPeerConnectionState) => void;
  onError: (message: string) => void;
}

const ICE_GATHER_TIMEOUT_MS = 8_000;

export class PeerTransport {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private closedByUs = false;

  constructor(
    private readonly rtcConfig: RTCConfiguration,
    private readonly handlers: PeerTransportHandlers,
  ) {}

  get isOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  get state(): RTCPeerConnectionState {
    return this.pc?.connectionState ?? 'closed';
  }

  async createOffer(): Promise<string> {
    this.close();
    this.closedByUs = false;
    const pc = this.createPeerConnection();
    const channel = pc.createDataChannel('duochat', { ordered: true });
    this.bindChannel(channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('Failed to create a connection offer.');
    return sdp;
  }

  async acceptOffer(offerSdp: string): Promise<string> {
    this.close();
    this.closedByUs = false;
    const pc = this.createPeerConnection();
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('Failed to create a connection answer.');
    return sdp;
  }

  async applyAnswer(answerSdp: string): Promise<void> {
    if (!this.pc) throw new Error('No pending connection offer.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Raw stats of the live connection, used to report whether it is direct or relayed. */
  async getStats(): Promise<RTCStatsReport | null> {
    return this.pc ? this.pc.getStats() : null;
  }

  sendJson(value: unknown): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(value));
      return true;
    } catch (error) {
      this.handlers.onError(`Direct send failed: ${String(error)}`);
      return false;
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onmessage = null;
      this.channel.onerror = null;
      try {
        this.channel.close();
      } catch {
        // Ignore double-close.
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        // Ignore double-close.
      }
      this.pc = null;
    }
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      this.handlers.onStateChange(pc.connectionState);
      if (
        (pc.connectionState === 'failed' || pc.connectionState === 'closed') &&
        !this.closedByUs
      ) {
        this.handlers.onClose();
      }
    };
    pc.ondatachannel = (event) => {
      this.bindChannel(event.channel);
    };
    return pc;
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.handlers.onOpen();
    channel.onclose = () => {
      if (!this.closedByUs) this.handlers.onClose();
    };
    channel.onerror = () => {
      this.handlers.onError('The direct channel reported an error.');
    };
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') this.handlers.onFrame(event.data);
    };
  }
}

async function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = ICE_GATHER_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) finish();
    };
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
    timer = window.setTimeout(finish, timeoutMs);
  });
}
