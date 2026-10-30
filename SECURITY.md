# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately (for example through GitHub's
"Report a vulnerability" on this repository) rather than in a public issue. Include steps
to reproduce and the affected version. Do not include real conversation content.

## What DuoChat protects, and what it does not

**Protects**

- Message content is end-to-end encrypted between the two paired devices (WebRTC DTLS, or
  the authenticated forward-secret channel on Bluetooth, or sealed blobs for
  store-and-forward). Signaling relays, STUN servers and TURN servers never see plaintext.
- Identity comes from a 12-word recovery phrase; keys live in the OS credential store.
- A paired contact's key is pinned. A different key for the same contact is refused.
- Local messages are encrypted at rest (desktop app with SQLite).

**Does not protect (be honest with your users)**

- **Metadata.** Signaling relays and STUN/TURN servers can see IP addresses, timing and
  message sizes. Public defaults are third-party services; run your own for more control.
- **Store-and-forward messages have no forward secrecy** (sealed boxes, not a ratchet).
  It is off by default.
- **A compromised device**, screenshots, keyboards, or OS backups.
- **Bluetooth** has not been tested on real radios, and on Android it is not enabled.
- Deleting data on one device never deletes it on the other
  ([docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)).

## Deployment hygiene

- Never commit keystores, signing keys, TURN credentials or `.env` files (all git-ignored).
- Run your relay and TURN server behind TLS and keep them patched.
- Ship only signed installers (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
