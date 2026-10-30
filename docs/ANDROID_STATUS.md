# Android status

Read this before trusting the Android app. **Nothing here has run on a phone or emulator.** It compiles, the
debug APK builds, and the JVM unit tests pass (see "Verification").

## What exists

* **No Firebase, no accounts.** `grep -ri firebase apps/android` returns nothing.
* **Mandatory 12-word recovery identity** (`security/Bip39.kt`, `RecoveryIdentity.kt`). First run shows the
  phrase, makes you re-enter two words, and only then creates the identity (`ui/Onboarding.kt`, no skip).
  "I already have a phrase" restores one. The same phrase gives the **same keys and uid as the TypeScript
  protocol** (checked against vectors, including a non-ASCII passphrase case). The phrase is never stored;
  only the derived private keys are, encrypted under a non-exportable Keystore AES key.
* **Contact cards** `DUOID1:` (`ContactCard.kt`) and an Add-friend dialog (`ui/ContactDialog.kt`): copy your card,
  paste your friend's, compare the safety number, pin. The pinned record stores the friend's ECDH key so
  blobs can be sealed to them. No QR scanner yet (copy/paste only).
* **Sealed blobs** (`Seal.kt`): ECDH P-256 + HKDF + AES-256-GCM, ECDSA-signed, exactly the desktop format, plus
  a byte-exact `CanonicalJson` (signatures cover it) and `mailboxFor`.
* **Signaling, replaceable** (`signaling/`): an interface, a `SignalingHub` that runs several at once,
  `RelayClient` (OkHttp WebSocket, the self-hosted relay protocol) and `NostrTransport` (BIP-340 Schnorr on
  secp256k1, a fresh random key per event, kinds 21733 / 31733, `t` / `d` / `expiration` tags).
* **Automatic reconnect for a paired friend** (`ChatEngine`): sealed `ready` / `offer` / `answer` exchange,
  the lower uid is the initiator, backoff 5 s doubling to 120 s, retry when Android reports a new network
  (`ConnectivityManager` callback). Manual codes still work and take priority while a manual attempt is open.
* **Optional store-and-forward** (off by default): sealed `msg` + `ack`, held by the relay, 7 day TTL. No
  forward secrecy for these messages (sealed box), same as desktop.
* **Liveness**: ping every 4 s while authenticated, pong echoes `at`, any inbound frame counts, 14 s of silence
  closes the channel as lost and the normal reconnect runs (`p2p/Liveness.kt`).
* **Network settings UI** (Settings > Network): Nostr relays, your own relay, STUN, TURN, always-relay,
  store-and-forward, Bluetooth toggle (the toggle only stores the setting; see gaps).
* **Real path reporting** from `PeerConnection.getStats` (host / srflx / prflx / relay rules), shown in
  Settings and the chat header. Never inferred from configuration.

## Verification (this sandbox)

* SDK 35 at `/tmp/claude-0/asdk/sdk`, Gradle 8.14.3 (`/opt/gradle/bin/gradle`), `ANDROID_HOME` set. Commands:
  `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `:app:assembleDebug` all succeed.
* **48 JVM unit tests pass** across 7 suites. The vector-driven ones compare Kotlin to
  `docs/android-vectors.json`, which `packages/protocol/scripts/gen-android-vectors.ts` produces from the
  TypeScript protocol (`npx vite-node scripts/gen-android-vectors.ts` in `packages/protocol`):
  * recovery: 4 phrases (one with the BIP-39 "TREZOR" passphrase, one with a non-ASCII passphrase): seed, both
    HKDF materials, both private scalars, both public points, uid, and that TypeScript's identity proof
    verifies against Kotlin's keys; entropy to mnemonic (4); invalid phrases (3)
  * canonical JSON: 8 cases incl. control characters, U+2028, emoji and a lone surrogate
  * contact cards decode to the TypeScript uid and re-encode identically; a forged card is rejected
  * sealed blobs made by TypeScript open in Kotlin in both directions; wrong recipient, wrong sender, wrong
    signer and a flipped ciphertext are all refused; mailbox hashes match
  * `NetworkConfig` parsing matches `parseNetworkConfig` on 7 inputs
  * BIP-340: the official vector 0, plus public key, reproducible signature, and event id all equal to
    `@noble/curves`; a Kotlin-built event is identical to the TypeScript one; TypeScript events verify
  * liveness frames: 8 accept/reject cases from `parsePeerFrame`; 14 s dead-link rule; backoff schedule
* **Real relay interop** (`RelayInteropTest`, 5 tests) starts `node relay/index.js` and a small NIP-01 relay
  (`src/test/resources/nostr-relay.mjs`) and runs two Kotlin clients through them: a sealed offer is
  delivered, store-and-forward holds a sealed message for an offline friend and replays it, an instance with
  store-and-forward disabled refuses `msg` but still relays `sig`, Nostr delivers a sealed blob. The test
  skips with a message if `node` or `relay/node_modules` is missing.
* **Kotlin to TypeScript**: the same test class writes `app/build/interop/kotlin-vectors.json`;
  `packages/protocol/test/androidInterop.test.ts` verifies the card, the sealed blob and the Nostr event with the
  TypeScript implementation (skipped when the file is absent).

## What is NOT done or NOT verified

* **Never run on a device or emulator.** That includes onboarding and add-friend screens, the Room migration
  2 to 3, a real WebRTC connection, the real `getStats` output, `ConnectivityManager` retry, Keystore storage
  of the new identity keys, and OkHttp on Android.
* **Background reconnect**: reconnection runs in the ViewModel scope, so it works while the app process is
  alive. There is no foreground service, so Android may stop it in the background. No push either (no FCM).
* **Cleartext**: Android blocks plain `ws://`; relays must be `wss://` (the UI says so). The JVM tests use `ws://`.
* **The recovery phrase is shown on screen with no `FLAG_SECURE`**, so screenshots and screen recording are not
  blocked. Not added yet.
* **Replacing the identity from Settings** is not offered on Android (only on first run); use the kill switch
  to wipe, then restore.
* **No QR** for contact cards.
* **P-256 and secp256k1 math is not constant time** (BigInteger). Documented in the code; the P-256 path runs
  once per phrase entry and the Nostr keys are throwaway per event.
* **Not tested across two real networks** and not against public Nostr relays.
* **Bluetooth** lives in `ble/` (another agent), is not wired into `ChatEngine`, and is untested on hardware.
* The Room schema is v3 (non-destructive 2 to 3 migration); an existing install gets a new identity and must
  pair again.
