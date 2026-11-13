/** Builds the hosted engine for the packaged app: migrates the identity, then wires the engine to the app's settings. */
import { loadNetworkConfig, loadTorMode, rtcConfigFor, saveNetworkConfig } from '../network';
import { notifyIncoming } from '../notifications';
import { secretDelete } from '../secureStore';
import { loadSettings } from '../settings';
import type { DeviceIdentity } from '../identity';
import { tauriEngineBridge } from '../engineBridge';
import { config } from '../../config';
import { HostedChatEngine } from './hostedEngine';
import { seedEngineIdentity } from './legacyIdentity';

export async function startHostedEngine(identity: DeviceIdentity): Promise<HostedChatEngine> {
  // The engine keeps its own copy of the identity (in the credential store). Give it ours the first time.
  await seedEngineIdentity(identity);
  await loadTorMode();
  const bridge = await tauriEngineBridge();
  return new HostedChatEngine({
    bridge,
    network: loadNetworkConfig,
    rtcConfig: () => rtcConfigFor(loadNetworkConfig()),
    ownName: () => loadSettings().displayName,
    onNotify: (message, title) => void notifyIncoming(message, title),
    persistStoreForward: () => saveNetworkConfig({ ...loadNetworkConfig(), storeForward: true }),
    deleteSecret: secretDelete,
    expectedUid: identity.uid,
    identity,
    context: config.conversationId,
  });
}
