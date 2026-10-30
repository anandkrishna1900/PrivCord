# Deployment guide

DuoChat has three things you may deploy. Only the apps are required; everything else is
optional infrastructure you can host yourself or leave to the public defaults.

| Component | Required | Where it runs |
|---|---|---|
| Windows desktop app | yes (or Android) | each user's PC |
| Android app | yes (or desktop) | each user's phone |
| Relay (signaling / store-and-forward) | no | a small server you control |
| TURN server | no, but needed on strict networks | a server with a public IP |

Be clear with users about what they are trusting: see [CONNECTIVITY.md](CONNECTIVITY.md).

## 1. Release checklist

1. Choose and add a `LICENSE` file (none exists yet).
2. Bump the version in one pass: `package.json` (root and `apps/desktop`, which feeds the
   in-app version), `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`,
   `apps/android/app/build.gradle.kts` (`versionName`, **and increase `versionCode`**).
3. `npm ci && npm run typecheck && npm test && npm run build:desktop`
4. `npm run e2e --workspace @duochat/desktop` (needs Playwright, see README).
5. Android: `cd apps/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
6. Tag `vX.Y.Z` and push the tag: `.github/workflows/release.yml` builds the installer,
   the Android bundle, and the relay image.
7. **Test the signed artifacts on real machines** before announcing (see section 6).

CI (`.github/workflows/ci.yml`) runs steps 3 to 5 on every pull request, plus a Windows
`cargo check` of the Tauri crate.

## 2. Windows desktop app

Prerequisites on a Windows build machine: Node.js 20+, Rust (stable, MSVC toolchain), the
Visual Studio Build Tools "Desktop development with C++" workload, and WebView2 (preinstalled
on Windows 11).

```bash
npm ci
npm run tauri:build      # NSIS installer in apps/desktop/src-tauri/target/release/bundle/nsis/
```

* The installer is per-user (`installMode: currentUser`), no admin rights needed.
* **Code signing.** An unsigned installer triggers Windows SmartScreen warnings. Obtain a
  code-signing certificate and configure Tauri's `bundle.windows` signing
  (`certificateThumbprint` / `signCommand`); see the Tauri 2 docs. Never commit the
  certificate.
* The webview's Content-Security-Policy (`tauri.conf.json`) allows `wss:`/`ws:` connections so
  the app can reach the signaling relays you configure. WebRTC and Bluetooth are not governed
  by it.
* Secrets (identity keys, the database encryption key) are stored in the Windows Credential
  Manager. Messages are in a local SQLite database, encrypted by the app.
* Bluetooth uses `btleplug` (central role only). Windows needs a Bluetooth 4.0+ adapter.
  **Untested on real radios.**

## 3. Android app

Prerequisites: JDK 17, Android SDK 35 (Android Studio or the command-line tools).

```bash
cd apps/android
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug          # debug APK
./gradlew :app:bundleRelease          # Play Store bundle (.aab)
./gradlew :app:assembleRelease        # release APK
```

* **Signing.** Create a release keystore once and keep it (and its passwords) in a password
  manager. Losing it means you can never update the published app. Never commit it.
  The release workflow reads `DUOCHAT_KEYSTORE_B64`, `DUOCHAT_KEYSTORE_PASSWORD`,
  `DUOCHAT_KEY_ALIAS`, `DUOCHAT_KEY_PASSWORD` from repository secrets.
* TURN defaults can be baked in at build time through `local.properties`
  (`turn.url`, `turn.username`, `turn.credential`); users can also change STUN and TURN in
  the app. Do not ship long-lived TURN credentials in a public build.
* The release build (`assembleRelease`/`bundleRelease`) was **not completed** in the development
  sandbox (the lint dependency download was rate-limited); only the debug build and unit tests
  were run, and the signing configuration was checked with `signingReport`. Do a full release
  build on a normal machine or in CI before shipping. Minification is deliberately off.
* There is no push service: Android receives messages only while the app is running and
  connected. See [ANDROID_STATUS.md](ANDROID_STATUS.md) for what is implemented and untested.

## 4. Relay (optional)

Use this if you do not want to depend on public Nostr relays for signaling, or if you want
store-and-forward on infrastructure you control. Details: [`relay/README.md`](../relay/README.md).

Quickest production setup, with automatic HTTPS:

```bash
cd relay
echo "RELAY_DOMAIN=relay.example.org" > .env
docker compose up -d
```

Then enter `wss://relay.example.org` under *Settings > Network > your own relay*.

* The relay is **not** STUN and **not** TURN and never carries live chat traffic.
* It sees mailbox hashes, blob sizes and timing; it cannot read blobs (they are sealed to the
  recipient and signed by the sender).
* Store-and-forward is **off** unless you set `ALLOW_STORE_FORWARD=true`. When on, sealed
  messages are kept on disk for up to 7 days; mount `/data` on a persistent volume.
* Health check: `GET /healthz` (counters only). Back off exposure with a firewall or rate
  limit at your proxy if you expect abuse.
* The Docker image build and the compose setup were written but **not run** in the
  environment where this was developed. Do a trial deploy before relying on it.

## 5. TURN server (optional, recommended for strict networks)

Without TURN, two devices behind symmetric NAT or restrictive firewalls cannot connect
directly. A TURN server relays the **already end-to-end encrypted** stream; it can see
metadata but not content. Run `coturn`:

```ini
# /etc/turnserver.conf (minimal; adapt)
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=duochat:CHANGE-THIS-LONG-RANDOM-PASSWORD
realm=turn.example.org
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Open UDP/TCP 3478, TCP 5349 and a UDP relay port range. Then add
`turn:turn.example.org:3478` (and `turns:turn.example.org:5349`) with the username and password
under *Settings > Network*. Use *Always relay* to hide users' IP addresses from each other.

## 6. Verify a real deployment

The development sandbox could not test these; do them before you call a build production-ready.

- [ ] Install the **signed** Windows installer on a clean machine; first-run phrase flow works;
      data survives a restart and is not readable as plain text on disk.
- [ ] Two devices on **different** networks (for example mobile data and home Wi-Fi) connect
      and message. Open *Settings > Connection* and record the reported path
      (*Direct, peer to peer* vs *Relayed through TURN*).
- [ ] The same pair with only TURN reachable (block UDP) still works and reports *Relayed*.
- [ ] Disable all internet on two nearby devices: Bluetooth connects (needs a phone as the
      peripheral side) and the path says *Bluetooth, no internet*. Android Bluetooth must not
      be enabled in a release until it has the secure-channel port.
- [ ] Kill the app on one side, restart: the pair reconnects automatically.
- [ ] Android install on a physical device; Room migration from any previous build.

## 7. What is *not* provided

No push notifications (there is no server to send them), no iOS or macOS/Linux builds
(the desktop code is portable but unbuilt and untested there), no multi-device sync, and no
Bluetooth mesh. Deleting local data never deletes the other person's copy.
