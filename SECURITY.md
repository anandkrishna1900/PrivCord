# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately (for example through GitHub's
"Report a vulnerability" on this repository) rather than in a public issue. Include steps
to reproduce and the affected version. Do not include real conversation content.

## What DuoChat protects, and what it does not

**Protects** (protocol v2, see [docs/rust/adr/ADR-011-protocol-v2.md](docs/rust/adr/ADR-011-protocol-v2.md))

- **Post-quantum, end to end.** Every key agreement is hybrid: P-256 ECDH combined with ML-KEM-768 (FIPS 203), so
  breaking it needs breaking both. "Harvest now, decrypt later" recordings stay unreadable to a future quantum computer.
- **Every link** (WebRTC, Bluetooth, the engine's own channel) carries a post-quantum channel with fresh keys per link
  and a new key for every frame (old keys erased): forward secrecy within and across sessions. Nothing travels outside
  it. Frames are padded, so their size says little about their content.
- **Offline messages** (store-and-forward through relays) are sealed to one-time hybrid keys the recipient handed over
  on an earlier link and erases after use: forward secrecy and post-quantum protection for them too. Other relayed
  blobs use a hybrid standing key replaced every week. Classic sealing is used only before two people have ever linked,
  and refused afterwards (no downgrade).
- Signaling relays, STUN servers and TURN servers never see plaintext.
- Identity comes from a 12-word recovery phrase; private keys live in the OS key store (Android Keystore, Windows
  Credential Manager). A paired contact's key is pinned; a different key for the same contact is refused.
- **Encrypted on disk.** The local database (messages, files, contacts, keys) is SQLCipher (AES-256 over every page),
  keyed with a random 256-bit key held only in the OS key store.

**Does not protect (be honest with your users)**

- **Metadata.** Signaling relays and STUN/TURN servers can see IP addresses, timing and
  approximate message sizes. Public defaults are third-party services; run your own for more control.
- **A compromised, unlocked device**, screenshots, keyboards, or OS backups.
- The post-quantum design has not had an independent cryptographic review.
- Deleting data on one device never deletes it on the other
  ([docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)).

## Deployment hygiene

- Never commit keystores, signing keys, TURN credentials or `.env` files (all git-ignored).
- Run your relay and TURN server behind TLS and keep them patched.
- Ship only signed installers (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
