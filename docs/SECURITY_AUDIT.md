# DuoChat — Security Audit

Date: 2026-10-30
Scope: security posture of the current implementation, evaluated against the requirements of the redesign (decentralized, multi-contact, E2EE, mesh + WebRTC). Companion to `ARCHITECTURE_AUDIT.md`.

## 1. Summary of findings (by severity)

| # | Severity | Finding |
|---|---|---|
| S-01 | **Critical** | No end-to-end encryption: message plaintext is stored in Firestore and readable by project admins, both members, and Firebase/Google infrastructure |
| S-02 | **Critical** | Plaintext message content and sender name are delivered through FCM `data` payload (`DuoMessagingService.kt`) and rendered into notification previews |
| S-03 | High | No key-change / identity-substitution protection on the cloud path: the device key registry (`users/{uid}/devices`) is written by the account owner without any rotation history; a compromised account can silently swap its identity key (no warning UI for key change) |
| S-04 | High | WebRTC relies solely on DTLS; there is no application-layer authentication binding of the DataChannel traffic to the verified identities (the peer-auth handshake proves identity, but message frames themselves are not authenticated payloads — any DTLS-establishment MITM compromising the transport would also expose content) |
| S-05 | High | No Bluetooth threat surface has been created yet; when BLE is added, every relay-observable field must be designed against the threat model up front (rotating addresses, no stable IDs in advertisements) |
| S-06 | Medium | Peer public-key cache (`peer.$uid.$deviceId`) is stored in plain SharedPreferences; attacker with device access can read/corrupt it (corruption → false key-change warnings; not key disclosure) |
| S-07 | Medium | Room schema has no migration/backup story (`exportSchema=false`); future schema migrations risk silent data loss without an explicit backup strategy |
| S-08 | Medium | Firestore `lastSeenAt`/read-state watermarks leak presence metadata to the project (acceptable for a private project; must be revisited when moving to relays) |
| S-09 | Low | TURN credentials in `local.properties`/BuildConfig ride SDP; acceptable but must never be committed; no secret scanning in CI |
| S-10 | Low | Hardcoded public STUN endpoints leak a small amount of usage metadata to Google/Cloudflare |
| S-11 | Info | `duochat-peer-auth-v1` challenge string binds conversation + uid + device + both nonces — good binding; but the challenge is Firebase-signaling-biased (`conversationId` is a build constant) |
| S-12 | Info | Local at-rest encryption (Android Keystore AES-GCM; Tauri keyring) is present and correctly used; keys are device-scoped as intended |

## 2. Positive properties to preserve

1. **Identity keys in hardware-backed storage** (Android Keystore EC P-256, non-extractable private; `SHA256withECDSA`), with DER↔P1363 conversion (a classic pitfall avoided).
2. **Peer authentication** via nonce-pair challenge → signature → `auth_ok`, with 15s timeout, trust downgrade to `UNVERIFIED`, and user-confirmed `CONFIRMED` state.
3. **Safety number** algorithm deterministically shared across platforms (six 5-digit groups), required confirmation before manual-keyed trust.
4. **Manual `DUO1:` pairing codes** that allow key cross-checking without any signaling server.
5. **Local AES-256-GCM storage** for messages and outbox rows on Android; SQLite + OS keyring on desktop.
6. **Hardened Android manifest baseline**: `allowBackup=false`, `usesCleartextTraffic=false`, data-extraction rules, notification preview setting respected.

## 3. Threat model review (current state)

| Threat | Currently protected? |
|---|---|
| Cloud operator reading messages | **No (S-01)** |
| Device thief extracting history | Partially: at-rest encryption depends on OS lock/keystore availability; no separate history encryption passphrase exists |
| Malicious middleman on the Internet path | Partially: transport-level only (TLS/DTLS). A transport compromise would expose content because there is no application-layer authentication (S-04) |
| MITM during WebRTC signaling | Partially: Firestore signal docs are TLS-transported but server-visible; a project-account compromise can substitute offers/answers (mitigated by `DUO1:` cross-check being manual/optional) |
| Replay of DataChannel frames | Not applicable at app layer today (single channel, ordered); replay must be addressed at ratchet level in the E2EE core |
| Impersonation at sign-in | Auth allowlist; standard credential threats apply (no 2FA option today) |
| Unknown future: malicious BLE relay | Will be addressed in Phase 5/6 design (encrypted payloads only, rate limits, relay sees neither plaintext nor participant identity) |

## 4. Required remediations, mapped to plan

| Finding | Remediation (phase) |
|---|---|
| S-01 | Implement X3DH + Double Ratchet core in `packages/protocol/e2ee` (Phase 2), then wire into both platforms (Phase 3/4) |
| S-02 | E2EE before any cloud/push path; suppress plaintext previews by default (Phase 3/10) |
| S-03 | Contact store with verified-fingerprint pins + key-change notices (Phase 3) |
| S-04 | All DataChannel frames become authenticated E2EE envelopes bound to the verified identity AD (Phase 3) |
| S-05 | Threat-model-first BLE design (Phase 5/6): rotating service UUIDs/hashes, hop+expiry fields, packet auth, rate limits |
| S-06 | Move peer pins to encrypted contact store w/ Keystore-wrapped key (Phase 3) |
| S-07 | Establish Room schema migrations + test backup/restore before v2 changes (Phase 2/3) |
| S-09 | Add secret scanning note + keep credentials in ignored files only (continuous) |

## 5. Honest limitations after remediation

- Decentralized relays and TURN servers observe traffic metadata (volume, timing, apparent endpoints), even with E2EE payloads.
- A device-compromise attacker can read current-session keys; forward secrecy bounds the damage to past sessions only if ratchet state is wiped on compromise detection (future work: paranoid mode).
- Push notifications without a trusted notifier cannot carry message previews; strategies are documented in `KNOWN_LIMITATIONS.md` (to be produced).
- E2EE core uses NIST P-256 (not Curve25519) because initial cross-platform implementation relies on WebCrypto and platform keystores, both native P-256; this is a documented, deliberate choice using only standardized primitives (see `docs/E2EE_PROTOCOL.md`).
