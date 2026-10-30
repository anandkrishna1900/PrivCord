# DuoChat

A private messenger for exactly two people. End-to-end encrypted, no accounts, no required
backend. Friends pair once with a contact card and then talk directly over WebRTC (internet)
or Bluetooth LE (no internet).

<p align="center">
  <img src="docs/screenshots/chat-dark.png" alt="DuoChat desktop, dark theme" width="720">
</p>

## What it is, and what it is not

DuoChat has **no required server and no account system**. It is **not serverless**. Reaching a
friend across the internet needs some infrastructure, and the app is explicit about which and
why. These roles are different things and are configured separately in *Settings > Network*:

| Role | What it does | Sees your messages? | Needed? |
|---|---|---|---|
| **Signaling** (Nostr relays or your own relay) | Delivers the encrypted offer/answer so paired friends find each other and reconnect automatically | No (sealed, signed blobs) | Only for automatic reconnect; connection codes work without it |
| **STUN** | Tells your device its public address for NAT traversal | No, no data passes through it | No; without it only same-network paths work |
| **TURN** | Relays the already-encrypted stream when no direct path exists (strict NAT/firewall) | Sees only DTLS ciphertext | No; add one if direct connections fail |
| **Store-and-forward relay** | Holds sealed messages while your friend is offline | No (sealed) | No. **Off by default** |
| **Bluetooth LE** | Local link with no internet at all | No | No |

The defaults use public third-party STUN servers (Google, Cloudflare) and public Nostr relays.
They see connection metadata (your IP address, when you connect), never message content.
Replace them with your own in *Settings > Network*, or run your own relay and TURN server
([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

The app always shows what it is really doing: the connection path (*Direct, same network*,
*Direct, peer to peer*, *Relayed through TURN*, *Bluetooth, no internet*) is read from the
live connection (`RTCPeerConnection.getStats`), never inferred from settings.

## Features

- **Identity from a mandatory 12-word recovery phrase.** The same phrase restores the same
  identity on any device. The phrase is never stored.
- **Pair once with a contact card**, compare a safety number, and the app pins your friend's
  key. Later connections are verified automatically; a different key is refused.
- **Direct WebRTC data channels** whenever possible, with automatic reconnect for paired
  friends and a heartbeat that notices a dead link in about 15 seconds.
- **Pluggable signaling**: public Nostr relays (decentralized, nothing to host) and/or your own
  [relay](relay/README.md).
- **Configurable STUN and TURN**, plus an "always relay" option that hides your IP address.
- **Optional encrypted store-and-forward** for messages sent while your friend is offline.
- **Bluetooth LE** with forward-secret link encryption (desktop wiring tested with a simulated
  radio only; see [Status](#status-what-is-verified)).
- **Local encrypted persistence** (SQLite in the desktop app, AES-GCM with a key in the OS
  credential store), an offline send queue, delivery and read receipts.
- **Emergency deletion** ("kill switch") for the local device
  ([docs/EMERGENCY_DELETION.md](docs/EMERGENCY_DELETION.md)).

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Shared TypeScript protocol: identity, sealed blobs, contact cards, secure channel, pairing, framing. Platform-independent and unit-tested. |
| `apps/desktop` | Windows desktop app: React + Vite UI in a Tauri 2 shell (Rust: secure storage, SQLite, Bluetooth). Playwright end-to-end suite in `e2e/`. |
| `apps/android` | Native Android app (Kotlin, Jetpack Compose). |
| `relay` | Optional self-hosted signaling / store-and-forward relay (Node.js, one dependency). |
| `docs` | Architecture and operations documentation. |

## Quick start (development)

Requires Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test                      # protocol + desktop unit tests
npm run dev:desktop           # UI in the browser at http://127.0.0.1:1420
```

The browser build uses a development store that is **not encrypted at rest** and cannot use
Bluetooth. Use the Tauri build for the real thing:

```bash
npm run tauri:dev             # needs Rust and the Tauri prerequisites
```

Run your own relay:

```bash
cd relay && npm install && node index.js    # see relay/README.md for Docker and TLS
```

Run the end-to-end suite (drives real browsers against a real relay, a Nostr relay, and a TURN
server; needs Playwright with Chromium):

```bash
npm run e2e --workspace @duochat/desktop
```

## Building and deploying

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the Windows installer, Android APK/AAB,
relay and TURN hosting, code signing, and the release checklist.

## Documentation

- [Connectivity architecture](docs/CONNECTIVITY.md): signaling vs STUN vs TURN vs relay, sealed blobs, wire formats
- [Identity and recovery](docs/IDENTITY_AND_RECOVERY.md)
- [Bluetooth transport](docs/BLE_TRANSPORT.md)
- [Emergency deletion](docs/EMERGENCY_DELETION.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [Android status](docs/ANDROID_STATUS.md)
- [Security policy](SECURITY.md)

## Status: what is verified

Be skeptical of anything not in the "verified" column.

| Area | Verified by | Not verified |
|---|---|---|
| Protocol (identity, sealing, secure channel, framing) | 100+ unit tests, cross-checked against independent vectors | n/a |
| Desktop app logic | Unit tests and a Playwright end-to-end suite: onboarding, card pairing, automatic reconnect through a relay and through Nostr, store-and-forward, stranger rejection, direct vs TURN-relayed path reporting, dead-link detection | Run on real hardware over the Tauri shell |
| Relay | Automated tests against the real server | Docker image build, production TLS setup |
| Bluetooth (desktop) | Real framing and encryption code on a **simulated radio**: no internet, nothing on the air in plaintext, tampering drops the link | **Any real Bluetooth radio.** Windows is central-only, so two desktops cannot link; a phone is needed |
| Android | Compiles; 48 JVM unit tests (checked against vectors generated by the TypeScript protocol, and a real relay); debug APK builds; release signing configuration parses | **Any real device or emulator.** The release build could not be completed in the development sandbox. Bluetooth is not wired into the Android engine and must not be enabled until it has the secure-channel port. No foreground service, so reconnect runs only while the app is open |
| Windows installer | Config reviewed | **Never built**: the Tauri build needs Windows and the MSVC toolchain |
| Two different internet connections (mobile data vs Wi-Fi) | **Not tested.** All "direct" results come from loopback; only the TURN-relayed path was exercised with a real TURN server | Cross-network NAT traversal on real networks |

Do not describe this app as "completely serverless". It depends on external signaling, STUN
and, in restrictive networks, TURN infrastructure, whichever you choose.

## License

No license has been chosen yet. Until the owner adds a `LICENSE` file, all rights are reserved.
