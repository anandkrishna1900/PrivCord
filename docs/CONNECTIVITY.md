# DuoChat connectivity architecture (v1)

DuoChat has **no required backend** and no accounts. It is **not serverless**:
reaching a friend across the internet needs some third-party or self-run
infrastructure. This document says exactly which, and for what. The five
roles below are different things and are configured separately.

| Role | Purpose | Sees message text? | Required? |
|---|---|---|---|
| **Signaling** | Delivers the encrypted WebRTC offer/answer so two devices can find each other | No (sealed, signed blobs) | Only for automatic reconnect; manual codes work without it |
| **STUN** | Tells a device its public IP:port for NAT traversal | No (no data passes) | No; without it only same-network/host paths work |
| **TURN** | Relays the (already end-to-end encrypted) WebRTC stream when no direct path exists | Sees only DTLS ciphertext | No; needed for strict NAT/firewalls |
| **Store-and-forward relay** | Holds sealed, signed messages while the contact is offline | No (sealed) | No; **off by default** |
| **Bluetooth (BLE)** | Local transport that needs no internet at all | No | No |

Honest summary: with signaling + STUN configured, two paired devices connect
directly when NAT allows; with TURN they can always connect but traffic may be
relayed (still encrypted end to end). With none configured, only manual codes on
the same network, or Bluetooth, work.

## 1. Identity (mandatory 12-word phrase)

* First run generates a 12-word BIP-39 phrase (`generateRecoveryPhrase`). The user
  must confirm two random words before the identity is created. No skip.
* `deriveIdentityFromPhrase(phrase, passphrase?)` gives `IdentityKeyPair`
  (`signKey` ECDSA P-256, `dhKey` ECDH P-256, `identityProof`).
* **uid = `identityFingerprintHex(dhKey.pubJwk)`** (64 hex chars). The same phrase
  restores the same uid on every platform.
* The phrase is never stored. The private keys live in the OS secure store
  (`ec-private-local` holds `signKey.privJwk`; `ec-dh-private-local` holds
  `dhKey.privJwk`).

## 2. Contact card (how two people first meet)

String form: `DUOID1:` + base64url(canonicalJson(card)).

```json
{ "v": 1, "sign": <public JWK>, "dh": <public JWK>, "proof": "<identityProof>",
  "name": "optional display hint" }
```

Valid iff `verifyIdentityProof(sign, dh, proof)`. uid is derived from `dh`.
Exchanged out of band (QR / paste). Both sides then compare the **safety number**
once (`deriveSafetyNumber`) and pin the contact. After pinning, all later
connections are verified automatically; a different key for a pinned uid is
refused.

## 3. Network configuration (all optional, all editable in Settings)

Stored locally (desktop `localStorage["duochat.network.v1"]`, Android DataStore):

```json
{
  "stun":      ["stun:stun.l.google.com:19302"],
  "turn":      [{ "urls": ["turn:turn.example.org:3478"], "username": "u", "credential": "p" }],
  "signaling": [
    { "kind": "nostr", "relays": ["wss://relay.damus.io", "wss://nos.lol"] },
    { "kind": "relay", "url": "wss://my-duochat-relay.example.org" }
  ],
  "storeForward": false,
  "forceRelay": false
}
```

* Defaults: STUN = Google + Cloudflare public servers (third-party, disclosed in the
  UI); `signaling` = the Nostr entry above; `turn` empty; `storeForward` false.
* `forceRelay` sets `iceTransportPolicy: "relay"` (used for TURN testing and by
  users who never want to expose their IP to the peer).
* An empty `signaling` list means manual codes only.

## 4. Sealed blobs (shared by signaling and store-and-forward)

Everything a relay carries is a **sealed blob**: JSON, then base64url on the wire.

```json
{ "v": 1, "to": "<recipient uid>", "from": "<sender uid>",
  "epk": <ephemeral ECDH public JWK>, "iv": "<b64url 12B>", "ct": "<b64url>",
  "sig": "<b64url ECDSA over canonicalJson({v,to,from,epk,iv,ct})>" }
```

* Key: `ECDH(ephemeral private, recipient dh public)` -> HKDF-SHA-256
  (salt `duochat-seal-v1`, info `to|from`) -> AES-256-GCM key; AAD = `to|from`.
* Plaintext is a typed JSON payload: `{ "t": "offer"|"answer"|"msg", ... }`.
  `offer`/`answer` carry the existing `ManualSignal` fields (`sdp`, `fromDeviceId`,
  `publicKeyJwk`, `nonce`); `msg` carries `{ id, text, at }`.
* Receiver checks `sig` against the **pinned** sender `sign` key, checks
  `to == own uid`, then decrypts. Anything else is dropped silently.
* v1 has no forward secrecy for store-and-forward messages (sealed box). The
  existing double-ratchet in `packages/protocol/src/e2ee` is the planned upgrade;
  docs and UI must say so.

## 5. Signaling interface (modular, replaceable)

TypeScript (`apps/desktop/src/lib/signaling/types.ts`); Kotlin mirrors it.

```ts
interface SignalingTransport {
  readonly name: string;                       // 'nostr' | 'relay' | ...
  start(mailbox: string, onBlob: (b: SealedBlob, id: string) => void): void;
  put(mailbox: string, blob: SealedBlob, opts: { ttlSec: number; kind: 'sig' | 'msg' }): Promise<void>;
  status(): 'idle' | 'connecting' | 'online' | 'error';
  stop(): void;
}
```

* `mailbox(uid) = sha256hex("duochat-mailbox-v1|" + uid)`. A client subscribes to
  its own mailbox and puts to the contact's mailbox.
* `kind: 'sig'` TTL <= 120 s. `kind: 'msg'` TTL <= 7 days, only if `storeForward`.
* Several transports may run at once; the first answer wins; duplicates are
  dropped by blob id.

### 5a. Self-hosted relay (`relay/`, Node + `ws`)

WebSocket, JSON frames (all fields strings/numbers):

* client -> `{ "op": "sub", "mailbox": "...", "since": <ms, optional> }`
* client -> `{ "op": "put", "mailbox": "...", "id": "...", "blob": "<b64url>", "ttl": <sec>, "kind": "sig"|"msg" }`
* server -> `{ "op": "event", "mailbox": "...", "id": "...", "blob": "...", "ts": <ms> }`
* server -> `{ "op": "ok", "id": "..." }` or `{ "op": "err", "reason": "..." }`
* client -> `{ "op": "del", "mailbox": "...", "id": "..." }` after receipt.

Limits: blob <= 64 KiB, `sig` ttl <= 120 s, `msg` ttl <= 7 d, <= 500 queued per
mailbox, per-IP rate limit. The relay stores opaque blobs only, no accounts.
`sig` items are delivered live and not persisted; `msg` items are persisted to disk.

### 5b. Nostr backend

Public Nostr relays act as decentralized, user-selectable signaling/mailbox.
Each blob is one event signed with a **fresh random secp256k1 key per event**
(unlinkable to the DuoChat identity; authenticity comes from the sealed `sig`).

* `kind 21733` (ephemeral range, not stored) for `sig`; `kind 31733`
  (parameterized replaceable-style, stored) for `msg`.
* Tags: `["t", mailbox]`, `["expiration", "<unix>"]`.
* `content` = base64url(sealed blob). Subscribe filter `{ "kinds":[21733,31733], "#t":[mailbox], "since": ... }`.

## 6. Connection lifecycle and recovery

1. Paired contact + signaling available: the peer with the lexicographically
   lower uid sends a sealed `offer` (full-ICE, non-trickle SDP); the other
   answers. Glare is avoided by that rule.
2. Retry with backoff `reconnectDelayMs(attempt)` (5 s doubling to 120 s), reset
   on success, also retried on network change/app foreground.
3. Manual codes remain as the last-resort path and for first contact.
4. Then the existing `hello` / `auth_proof` / `auth_ok` challenge over the data
   channel (unchanged) pins identity, regardless of how signaling happened.
5. Messages queue locally (encrypted at rest) and flush when a path exists.
   With `storeForward`, undelivered messages are also put as sealed `msg` blobs and
   deleted by the receiver after it acks.

## 7. Reporting the real path (no guessing)

After the data channel opens, read `RTCPeerConnection.getStats()`: find the
`candidate-pair` with `state == "succeeded"` and `nominated`, then its local and
remote `candidate` `candidateType`:

| local / remote types | reported as |
|---|---|
| `host` + `host` | **Direct, same network** |
| any of `srflx`/`prflx`/`host` (no `relay`) | **Direct, peer to peer (NAT traversed)** |
| either side `relay` | **Relayed through TURN** (traffic is encrypted but passes through the TURN server) |

Shown in the UI and in diagnostics; never inferred from configuration. Android
uses `PeerConnection.getStats` with the same rules.

## 8. Transports other than WebRTC

All transports carry the same JSON frames and the same `hello` handshake.

```ts
interface MessageTransport {
  readonly kind: 'webrtc' | 'ble';
  readonly isOpen: boolean;
  sendJson(value: unknown): boolean;
  close(): void;
}
```

Bluetooth LE (see `docs/BLE_TRANSPORT.md`): works with the internet off, only
within BLE range, lower throughput; implemented natively per platform and marked
**untested until verified on real devices**.
