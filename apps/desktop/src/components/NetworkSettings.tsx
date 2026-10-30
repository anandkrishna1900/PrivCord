import { useEffect, useState } from 'react';
import {
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NOSTR_RELAYS,
  isIceUrl,
  isWsUrl,
  type NetworkConfig,
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

/** STUN, TURN, signaling and relays are different things; each has its own box. */
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
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [stun, turnUrls, turnUser, turnPass, nostr, relays, storeForward, forceRelay]);

  function build(): { config: NetworkConfig; problems: string[] } {
    const issues: string[] = [];
    const stunList = lines(stun);
    stunList.filter((u) => !isIceUrl(u, ['stun', 'stuns'])).forEach((u) => issues.push(`Not a STUN address: ${u}`));
    const turnList = lines(turnUrls).map((l) => l.split(',').map((u) => u.trim()).filter(Boolean));
    turnList.flat().filter((u) => !isIceUrl(u, ['turn', 'turns'])).forEach((u) => issues.push(`Not a TURN address: ${u}`));
    if (turnList.length > 0 && (!turnUser || !turnPass)) issues.push('TURN needs a username and password.');
    const nostrList = lines(nostr);
    nostrList.filter((u) => !isWsUrl(u)).forEach((u) => issues.push(`Not a ws:// or wss:// address: ${u}`));
    const relayList = lines(relays);
    relayList.filter((u) => !isWsUrl(u)).forEach((u) => issues.push(`Not a ws:// or wss:// address: ${u}`));
    if (forceRelay && turnList.length === 0) issues.push('"Always relay" needs a TURN server, otherwise nothing can connect.');
    const config: NetworkConfig = {
      stun: stunList.filter((u) => isIceUrl(u, ['stun', 'stuns'])),
      turn: turnList
        .map((urls) => urls.filter((u) => isIceUrl(u, ['turn', 'turns'])))
        .filter((urls) => urls.length > 0)
        .map((urls) => ({ urls, username: turnUser, credential: turnPass })),
      signaling: [
        ...(nostrList.length > 0 ? [{ kind: 'nostr' as const, relays: nostrList.filter(isWsUrl) }] : []),
        ...relayList.filter(isWsUrl).map((url) => ({ kind: 'relay' as const, url })),
      ],
      storeForward,
      forceRelay,
    };
    return { config, problems: issues };
  }

  function save() {
    const { config, problems: issues } = build();
    setProblems(issues);
    if (issues.length > 0) return;
    saveNetworkConfig(config);
    engine?.reloadNetwork();
    setSaved(true);
  }

  function reset() {
    setStun(DEFAULT_NETWORK_CONFIG.stun.join('\n'));
    setTurnUrls('');
    setTurnUser('');
    setTurnPass('');
    setNostr(DEFAULT_NOSTR_RELAYS.join('\n'));
    setRelays('');
    setStoreForward(false);
    setForceRelay(false);
  }

  const status = state?.signaling ?? 'idle';
  return (
    <section className="settings-section">
      <header>
        <h3>Network</h3>
        <p className="muted">
          DuoChat has no required server. These are the optional services it can use to find your friend and
          get through firewalls. None of them can read your messages.
        </p>
      </header>

      <label className="field">
        <span>Signaling: Nostr relays (finds your friend; decentralized, one per line)</span>
        <textarea rows={3} value={nostr} onChange={(e) => setNostr(e.target.value)} placeholder="wss://relay.example" />
      </label>
      <label className="field">
        <span>Signaling: your own DuoChat relay (optional, one per line)</span>
        <textarea rows={2} value={relays} onChange={(e) => setRelays(e.target.value)} placeholder="wss://my-relay.example.org" />
      </label>
      <p className="muted small">
        Signaling status: <strong>{status}</strong>. Leave both empty to use connection codes only.
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
        label="Always relay through TURN"
        hint="Hides your IP address from your friend. Slower, and needs a TURN server."
        checked={forceRelay}
        onChange={setForceRelay}
      />
      <Toggle
        label="Store-and-forward relay (messages while your friend is offline)"
        hint="Sends each message, encrypted for your friend, to the relays above so it arrives when they come online. Off by default. No forward secrecy for these messages."
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
