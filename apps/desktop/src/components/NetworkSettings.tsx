import { useEffect, useState } from 'react';
import {
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NOSTR_RELAYS,
  isIceUrl,
  isWsUrl,
  type NetworkConfig,
  type TransportMode,
} from '@duochat/protocol';
import type { ChatEngine, ChatState } from '../lib/engine';
import { loadNetworkConfig, saveNetworkConfig } from '../lib/network';
import { CheckIcon, InfoIcon } from './Icons';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <p className="muted small">{hint}</p>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </div>
  );
}

/** STUN, TURN, signaling, relays, and transport mode selector. */
export function NetworkSettings({ engine, state }: { engine: ChatEngine | null; state: ChatState | null }) {
  const [initial] = useState(loadNetworkConfig);
  const [stun, setStun] = useState(initial.stun.join('\n'));
  const [turnUrls, setTurnUrls] = useState(initial.turn.map((t) => t.urls.join(',')).join('\n'));
  const [turnUser, setTurnUser] = useState(initial.turn[0]?.username ?? '');
  const [turnPass, setTurnPass] = useState(initial.turn[0]?.credential ?? '');
  const [nostr, setNostr] = useState((initial.signaling.find((s) => s.kind === 'nostr')?.relays ?? []).join('\n'));
  const [relays, setRelays] = useState(
    initial.signaling.flatMap((s) => (s.kind === 'relay' ? [s.url] : [])).join('\n'),
  );
  const [storeForward, setStoreForward] = useState(initial.storeForward);
  const [forceRelay, setForceRelay] = useState(initial.forceRelay);
  const [bluetooth, setBluetooth] = useState(initial.bluetooth);
  const [transportMode, setTransportMode] = useState<TransportMode>(initial.transportMode ?? 'AUTOMATIC');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [stun, turnUrls, turnUser, turnPass, nostr, relays, storeForward, forceRelay, bluetooth, transportMode]);

  function validate(): { config: NetworkConfig; errors: string[] } {
    const errors: string[] = [];
    const stunList = lines(stun).flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean);
    const badStun = stunList.filter((u) => !isIceUrl(u, ['stun', 'stuns']));
    if (badStun.length > 0) errors.push(`Invalid STUN URL: ${badStun[0]}`);

    const turnList: NetworkConfig['turn'] = [];
    const rawTurn = lines(turnUrls);
    if (rawTurn.length > 0) {
      if (!turnUser || !turnPass) {
        errors.push('TURN username and password are required when TURN servers are configured.');
      }
      for (const line of rawTurn) {
        const urls = line.split(',').map((u) => u.trim()).filter(Boolean);
        const bad = urls.filter((u) => !isIceUrl(u, ['turn', 'turns']));
        if (bad.length > 0) errors.push(`Invalid TURN URL: ${bad[0]}`);
        if (urls.length > 0) turnList.push({ urls, username: turnUser, credential: turnPass });
      }
    }

    const signaling: NetworkConfig['signaling'] = [];
    const nostrList = lines(nostr);
    const badNostr = nostrList.filter((u) => !isWsUrl(u));
    if (badNostr.length > 0) errors.push(`Invalid Nostr relay URL: ${badNostr[0]}`);
    if (nostrList.length > 0) signaling.push({ kind: 'nostr', relays: nostrList });

    const relayList = lines(relays);
    const badRelays = relayList.filter((u) => !isWsUrl(u));
    if (badRelays.length > 0) errors.push(`Invalid DuoChat relay URL: ${badRelays[0]}`);
    for (const u of relayList) signaling.push({ kind: 'relay', url: u });

    if (forceRelay && turnList.length === 0) {
      errors.push('To force TURN relay you must configure at least one working TURN server.');
    }

    return {
      config: {
        stun: stunList,
        turn: turnList,
        signaling,
        storeForward,
        forceRelay,
        bluetooth,
        transportMode,
      },
      errors,
    };
  }

  function save() {
    const { config, errors } = validate();
    setProblems(errors);
    if (errors.length > 0) return;
    saveNetworkConfig(config);
    engine?.reloadNetwork();
    setSaved(true);
  }

  function reset() {
    const d = DEFAULT_NETWORK_CONFIG;
    setStun(d.stun.join('\n'));
    setTurnUrls('');
    setTurnUser('');
    setTurnPass('');
    setNostr((d.signaling.find((s) => s.kind === 'nostr')?.relays ?? []).join('\n'));
    setRelays('');
    setStoreForward(d.storeForward);
    setForceRelay(d.forceRelay);
    setBluetooth(d.bluetooth);
    setTransportMode(d.transportMode ?? 'AUTOMATIC');
    setProblems([]);
    saveNetworkConfig(d);
    engine?.reloadNetwork();
    setSaved(true);
  }

  const status = state?.signaling ?? 'idle';
  return (
    <section className="settings-section">
      <header>
        <h3>Network & Communication Mode</h3>
        <p className="muted">
          DuoChat operates peer-to-peer without central accounts. Select your preferred transport mode below.
        </p>
      </header>

      <div className="field">
        <span>Transport Selector</span>
        <div className="button-group" style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
          <button
            type="button"
            className={`button ${transportMode === 'AUTOMATIC' ? 'primary' : 'secondary'} small`}
            onClick={() => setTransportMode('AUTOMATIC')}
          >
            1. Automatic (Default)
          </button>
          <button
            type="button"
            className={`button ${transportMode === 'BLUETOOTH_ONLY' ? 'primary' : 'secondary'} small`}
            onClick={() => setTransportMode('BLUETOOTH_ONLY')}
          >
            2. Bluetooth Only
          </button>
          <button
            type="button"
            className={`button ${transportMode === 'INTERNET_ONLY' ? 'primary' : 'secondary'} small`}
            onClick={() => setTransportMode('INTERNET_ONLY')}
          >
            3. Internet Only
          </button>
        </div>
        <p className="muted small" style={{ marginTop: '4px' }}>
          {transportMode === 'AUTOMATIC' && 'Tries direct BLE, then BLE Mesh, then WebRTC P2P, then decentralized relay outbox.'}
          {transportMode === 'BLUETOOTH_ONLY' && 'Never touches Internet, WebRTC, TURN, or Nostr relays. Direct radio and BLE mesh only.'}
          {transportMode === 'INTERNET_ONLY' && 'Disables Bluetooth completely; uses WebRTC P2P and configured relays.'}
        </p>
      </div>

      <label className="field">
        <span>Signaling: Nostr relays (finds your friend; decentralized, one per line)</span>
        <textarea rows={3} value={nostr} onChange={(e) => setNostr(e.target.value)} placeholder="wss://relay.example" />
      </label>
      <label className="field">
        <span>Signaling: your own DuoChat relay (optional, one per line)</span>
        <textarea rows={2} value={relays} onChange={(e) => setRelays(e.target.value)} placeholder="wss://my-relay.example.org" />
      </label>
      <p className="muted small">
        Signaling status: <strong>{status}</strong>.
      </p>

      <label className="field">
        <span>STUN servers (learn your public address; no messages pass through)</span>
        <textarea rows={2} value={stun} onChange={(e) => setStun(e.target.value)} placeholder="stun:stun.example.org:3478" />
      </label>

      <label className="field">
        <span>TURN servers (relay traffic when no direct path exists; one per line, comma-separate alternatives)</span>
        <textarea rows={2} value={turnUrls} onChange={(e) => setTurnUrls(e.target.value)} placeholder="turn:turn.example.org:3478" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>TURN username</span>
          <input value={turnUser} onChange={(e) => setTurnUser(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>TURN password</span>
          <input type="password" value={turnPass} onChange={(e) => setTurnPass(e.target.value)} autoComplete="off" />
        </label>
      </div>

      <Toggle
        label="Bluetooth (works with no internet)"
        hint="Also look for your friend over Bluetooth LE when you are close by. Needs a Bluetooth-capable build."
        checked={bluetooth}
        onChange={setBluetooth}
      />
      <Toggle
        label="Always relay through TURN"
        hint="Hides your IP address from your friend. Slower, and needs a TURN server."
        checked={forceRelay}
        onChange={setForceRelay}
      />
      <Toggle
        label="Store-and-forward relay (messages while your friend is offline)"
        hint="Sends each message, encrypted for your friend, to the relays above so it arrives when they come online."
        checked={storeForward}
        onChange={setStoreForward}
      />

      {problems.length > 0 ? (
        <div className="callout warning" role="alert">
          <InfoIcon size={17} />
          <div>
            {problems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </div>
      ) : null}
      <div className="button-row">
        <button type="button" className="button primary" onClick={save}>
          <CheckIcon size={15} />
          {saved ? 'Saved' : 'Save network settings'}
        </button>
        <button type="button" className="button ghost" onClick={reset}>
          Reset to defaults
        </button>
      </div>
      <div className="callout subtle">
        <InfoIcon size={17} />
        <p>
          Default STUN and Nostr servers are public third-party services. They see connection metadata (your IP
          address and when you connect), never message content. Run your own relay or TURN server to avoid that.
        </p>
      </div>
    </section>
  );
}
