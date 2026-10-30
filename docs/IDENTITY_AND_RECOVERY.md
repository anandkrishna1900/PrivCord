# DuoChat — Identity & 12-Word Recovery Specification

**Specification Version**: 1.0  
**Derivation Version**: `duochat-derive-v1`  
**Date**: October 2026

---

## 1. Cryptographic Identity Overview

Every DuoChat user identity is anchored in a 12-word cryptographic recovery phrase based on **BIP-39** with exactly **128 bits of cryptographically secure random entropy**.

Key properties:
- **Strictly 12 words**: 128 bits entropy + 4 bits checksum = 132 bits / 11 bits per word = 12 words. DuoChat never generates 24-word phrases.
- **Audited Cryptographic Primitives**: Uses `@scure/bip39` for mnemonic generation, wordlist checks, and checksum validation.
- **Hardware-backed Storage**: On Android, identity keys are secured using Android Keystore (when hardware keystore is supported) and private app storage. On Desktop, keys are stored via the OS-backed secure credential store.
- **Zero-knowledge & Privacy**: Recovery words are never transmitted to any external server, never included in logs or crash dumps, and never stored in plaintext at rest.

---

## 2. Deterministic Key Derivation Scheme

DuoChat does not use the recovery mnemonic or seed directly as an encryption or signing key. Instead, the BIP-39 seed is passed through versioned, domain-separated HKDF-SHA-256 derivations to produce independent keys for distinct cryptographic purposes.

### Derivation Pipeline:

```
[128-bit CSPRNG Entropy]
          │
          ▼
   12-word BIP-39 phrase
          │
          ▼ (Optional BIP-39 passphrase)
   512-bit BIP-39 Seed (PBKDF2-HMAC-SHA-512, 2048 rounds)
          │
          ├── Salt: "DuoChat-Recovery-Trust-v1"
          │
          ├── HKDF-Expand(Info: "duochat-derive-v1/identity-sign")
          │     └── Clamped scalar (mod NIST P-256 order)
          │           └── ECDSA P-256 Signing Key Pair
          │
          └── HKDF-Expand(Info: "duochat-derive-v1/identity-agreement")
                └── Clamped scalar (mod NIST P-256 order)
                      └── ECDH P-256 Key Agreement Pair
```

### Purpose Separation:
1. `duochat-derive-v1/identity-sign`: Used exclusively for digital signatures (device identity self-proof and message authentication).
2. `duochat-derive-v1/identity-agreement`: Used exclusively for asymmetric Diffie-Hellman key exchange (X3DH and initial ratchet establishment).

**Rule**: The same key is **never** reused for both signing and encryption.

---

## 3. Setup Flow

1. **Generation**: Exactly 12 words are drawn from the official BIP-39 English wordlist.
2. **Display & Education**: Words are shown in numbered order with clear warnings:
   - "This phrase is your master identity backup."
   - "Never share this phrase with anyone."
   - "DuoChat support will never ask for your recovery phrase."
3. **Optional Passphrase**: Users may configure an optional BIP-39 passphrase (13th word). The UI explicitly explains that if a passphrase is set, restoration requires both the 12 words and the exact passphrase.
4. **Verification Step**: Users are prompted to verify randomly selected words (e.g., word #3 and word #9) to guarantee manual offline backup before proceeding.
5. **Finalization**: Keys are derived, stored in secure local storage, and the phrase is wiped from memory.

---

## 4. Restoration Flow

Users who reinstall DuoChat or switch devices can restore their identity:

1. **Input**: User inputs their 12 words (and optional passphrase if one was configured).
2. **Validation**:
   - Word count validation (strictly 12 words).
   - Wordlist membership check.
   - BIP-39 checksum integrity verification.
3. **Derivation**: Derives the exact byte-identical P-256 signing and ECDH keys.
4. **Cryptographic Trust**: Contacts verify the safety fingerprint derived from the public point.
5. **No Local History Restoration**: The UI explicitly informs the user that locally deleted message histories cannot magically reappear without a separate backup, preserving honest security boundaries.

