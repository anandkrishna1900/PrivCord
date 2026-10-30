# Bluetooth LE transport (v1)

> **Status: UNTESTED ON HARDWARE.** The framing and tag code is unit-tested
> (TypeScript and Kotlin against shared vectors). Nothing that touches a real
> Bluetooth radio has been run. The Android GATT code has not even been compiled
> yet (no Android SDK was available when it was written). Treat every behavior
> below as a design until you have run the test checklist in section 9 on real
> devices.

Purpose: let two **already paired** devices exchange DuoChat's normal JSON
frames with no internet at all, within Bluetooth range. It is a second
`MessageTransport` (docs/CONNECTIVITY.md section 8); it does not replace WebRTC.

## 1. What each platform can do

| | Peripheral (advertise + GATT server) | Central (scan + connect) |
|---|---|---|
| **Android** (API 26+) | Yes | Yes |
| **Windows desktop** (btleplug) | **No.** btleplug has no GATT-server or advertising API | Yes |

Consequences, stated plainly:

* phone <-> phone: works in either direction; the lower uid acts as central.
* phone <-> Windows desktop: the **phone must be the peripheral**, the desktop is
  the central. The phone therefore always advertises (see section 6).
* **desktop <-> desktop over Bluetooth is not possible** with this design
  (neither side can advertise).
* macOS/Linux desktops are not a target for BLE in v1.
* **First contact is not done over Bluetooth.** The shared secret that makes tags
  recognizable (section 3) comes from the contact card exchanged earlier
  (docs/CONNECTIVITY.md section 2). Bluetooth only reconnects contacts that are
  already pinned.

## 2. GATT design

One primary service, two characteristics. All UUIDs were generated once for
DuoChat and are fixed:

| Item | UUID | Properties |
|---|---|---|
| Service | `fee43cae-8420-4563-8172-f73479794ee7` | primary |
| **RX** (central -> peripheral) | `fee43cae-8420-4563-8172-f73479794ee8` | write **without response** |
| **TX** (peripheral -> central) | `fee43cae-8420-4563-8172-f73479794ee9` | **notify** (standard CCCD `0x2902`) |

The service UUID is **not advertised** (section 3); a central learns it only
after connecting and discovering services.

### MTU and chunk size

* The central requests ATT MTU **517** right after connecting (Android:
  `requestMtu(517)`; the peripheral reports the result in `onMtuChanged`). The
  default MTU is 23.
* Usable bytes per write or notification = `MTU - 3` (ATT header). The chunk size
  passed to the framing layer is that number, header included.
* Android sets chunk = `MTU - 3` per link. The desktop asks btleplug for
  `Peripheral::mtu()` and falls back to **20 bytes** when it reports nothing
  useful. Each side chunks for what it sends; the other side reassembles whatever
  arrives, so the two directions may use different sizes.

## 3. Advertising: rotating tag, no identifiable service

The peripheral advertises **only** manufacturer-specific data: company id
`0xFFFF` (the SIG value reserved for testing) followed by an 8-byte tag. No
device name, no service UUID, no TX power.

```
epoch = floor(unixSeconds / 900)                      # 15-minute epochs
tag   = HMAC-SHA-256(secret, "duochat-ble-tag-v1|" + epoch)[0..8)
```

`secret` = the 32-byte ECDH secret between the two identity DH keys (computed
by the app, never transmitted). The scanner accepts the **previous, current and
next** epoch's tag (tolerates up to one epoch of clock skew) and connects only on
a match. The peripheral re-advertises with the new tag at each epoch boundary.
Reference vectors: `docs/ble-vectors.json` (`tag`).

### Privacy: what this does and does not give you

* A stranger scanning cannot tell a DuoChat device from any other BLE
  accessory: no service UUID, a tag that looks random and changes every 15
  minutes, and it cannot be linked across epochs without `secret`.
* Only your contact (who has `secret`) can recognize you.
* **It does not hide that a BLE device is present.** Anyone nearby sees *a*
  device advertising. Presence and signal strength are visible.
* **The radio's Bluetooth address can still link you.** If the platform keeps the
  same address across epochs, an observer can correlate your tags over time.
  Android advertisers normally use a rotating random address, but this is
  platform behavior we do not control and have not verified.
* Once a link is up, the connection is **not encrypted by BLE pairing**: we do not
  use BLE bonding. Confidentiality and authenticity come from the DuoChat
  handshake (section 5). Frames on the air are therefore plaintext JSON until
  that is implemented; see section 8.
* Someone who knows the GATT UUIDs and your address could still connect and then
  fail the handshake. That is a nuisance (the link is dropped), not a
  confidentiality break.

## 4. Chunking and reassembly

BLE writes/notifications are tiny, so every JSON frame (UTF-8, max **65,536
bytes**) is split into chunks. GATT delivers writes and notifications in order,
so there are **no acks and no retransmits**.

```
chunk = flags (1 byte) | seq (2 bytes, big-endian) | payload (>= 1 byte)
flags: bit0 = START (first chunk), bit1 = END (last chunk), bits 2-7 must be 0
seq:   0-based chunk index within the message
```

Rules (both implementations, enforced by the shared vectors):

* The first chunk has `START` and `seq 0`; chunks follow with `seq` +1 each; the
  last has `END`. A one-chunk message has flags `0x03`.
* Minimum chunk size is 4 bytes (header + 1 payload byte); a 64 KiB message at
  that size needs exactly 65,536 chunks, so `seq` never overflows 16 bits.
* The reassembler **throws and resets** on: chunk shorter than 4 bytes, unknown
  flag bits, a continuation without START, START with `seq != 0`, a gap or
  duplicate, or a message growing past 65,536 bytes. A new `START` silently
  discards a half-received message (the sender restarted). After an error the next
  well-formed `START` resynchronizes.
* There is no per-message length or checksum: GATT/LL already CRC each packet,
  and a corrupted JSON frame fails to parse. This is a deliberate simplification.
  Add a length+CRC32 field if real devices show silent corruption.
* Writes are queued per link and issued one at a time, waiting for the
  platform's completion callback (`onCharacteristicWrite` / `onNotificationSent`).

Code: `apps/android/.../ble/BleFraming.kt` (`BleFraming`, `BleReassembler`,
`BleTag`) and `apps/desktop/src/lib/bleFraming.ts`. Vectors:
`docs/ble-vectors.json` (generated by an independent Python implementation).

## 5. Identity handshake over BLE

Unchanged. As soon as the link opens (TX notifications enabled), both sides run
the existing `hello` / `auth_proof` / `auth_ok` exchange as JSON frames over the
BLE link, exactly as over a WebRTC data channel: hello carries uid, deviceId,
identity key and nonce; the key must match the pinned contact; the peer proves
possession by signing the challenge. Until `auth_ok` is exchanged in both
directions the app must treat the link as unauthenticated and drop every
non-handshake frame. The engine must not care which transport carried the
frames.

## 6. Roles and link selection

* Android always runs the **peripheral** role (advertises the tag, hosts the
  service) so a Windows desktop can find it.
* Android additionally scans (central role) only when `initiateAsCentral` is
  true. Callers pass `ownUid < peerUid`, so two phones never both connect to each
  other.
* The Windows desktop is central only and always initiates.
* One link at a time: a second incoming connection is refused while a link is
  open; a successful link stops scanning. If the link drops, advertising
  continues and scanning restarts so the contact can reconnect.

## 7. Throughput and range (expectations, not measurements)

Nothing below was measured. BLE GATT with write-without-response typically
reaches a few kB/s with the default 23-byte MTU and tens of kB/s with a large
MTU and a short connection interval, and varies a lot by phone and OS. Text chat
frames are small, so this should be adequate; a 64 KiB frame at 20-byte chunks is
about 3,900 writes and will take many seconds. Typical BLE range is roughly 10 m
indoors and drops sharply through walls and bodies. No relaying: both devices
must be in direct radio range.

## 8. Link encryption and known gaps

**Link encryption (desktop: implemented and simulated-radio tested; Android: not yet).**
BLE itself is not relied on for secrecy. Every frame after the first is wrapped by
`SecureChannel` (`packages/protocol/src/connectivity/secureChannel.ts`):

1. Each side sends `sc_hello` = a fresh ephemeral ECDH P-256 key + random nonce, signed with
   its identity signing key over `(own uid | peer uid | ephemeral key | nonce)`.
2. The receiver verifies the signature against the **pinned** contact's signing key.
   Anyone else cannot complete the handshake.
3. Keys: HKDF-SHA-256 over the ephemeral ECDH secret, salted with both nonces, one key per
   direction. Frames are AES-256-GCM with a strictly increasing counter as the IV; replayed,
   reordered, or tampered frames are rejected and the link is dropped.
4. Ephemeral keys give forward secrecy: recording the air and later stealing the identity
   key does not reveal past sessions.
5. The normal `hello`/`auth_proof`/`auth_ok` handshake then runs *inside* the encrypted
   channel, so identity details are never visible over the air.

Tested: 5 protocol unit tests (round trip, tamper, replay, impostor, forward secrecy) and a
desktop end-to-end scenario with a *simulated* radio that records every chunk and asserts the
message text and handshake never appear in it, and that a flipped bit drops the link.

**Still open**

* Android has no `SecureChannel` port yet, so Android Bluetooth must not be enabled until it
  has one (it would be unencrypted).
* Nothing here has run on a real Bluetooth radio. Timing, MTU, pairing prompts, background
  scanning limits, and range are unmeasured.
* No store-and-forward and no multi-hop mesh (unlike Bitchat). Two devices, one link.
* No BLE-based first contact: contact cards must be exchanged beforehand.
* Windows needs a Bluetooth 4.0+ adapter; behaviour of btleplug's WinRT backend with
  manufacturer-data matching has not been verified.
* The Windows desktop is central-only, so two desktops cannot connect to each other over
  Bluetooth; a phone must be the other side.

## 9. Permissions

| Platform | Needed |
|---|---|
| Android 12+ (API 31+) | Runtime: `BLUETOOTH_SCAN` (declared `neverForLocation`), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` |
| Android 8-11 (API 26-30) | Manifest: `BLUETOOTH`, `BLUETOOTH_ADMIN`; runtime `ACCESS_FINE_LOCATION` (scanning). Location services must be on |
| Windows 10/11 | Bluetooth on; no extra permission for an unpackaged NSIS app. A packaged/MSIX build needs the `bluetooth` device capability |
| macOS (not a v1 target) | `NSBluetoothAlwaysUsageDescription` in Info.plist |

`uses-feature android.hardware.bluetooth_le` is `required=false`: the app still
installs on phones without BLE.

## 10. Android hookup (not wired; the other Android agent owns ChatEngine)

```kotlin
// 1. After the user grants BLUETOOTH_SCAN/ADVERTISE/CONNECT (API 31+) or location (<=30):
val ble = BleTransport(
    context = appContext,
    secretProvider = { contactEcdhSecret32 },          // ECDH(ownDhPriv, peerDhPub), 32 bytes
    initiateAsCentral = ownUid < peerUid,
    handlers = object : BleTransport.Handlers {
        override fun onOpen() = session.onTransportOpen()          // starts hello handshake
        override fun onClose() = session.onTransportClosed()
        override fun onFrame(data: String) = session.onFrame(data)  // same as WebRtcTransport
        override fun onError(message: String) = session.onError(message)
    },
)
ble.start()                       // advertises (+ scans if initiateAsCentral)
// 2. Send with ble.sendJson(frame); check ble.isOpen; stop with ble.close().
// 3. Prefer WebRTC when it is open; fall back to BLE otherwise (keep both transports alive).
```

## 11. Desktop hookup

`apps/desktop/src/lib/ble.ts` exports `BleTransport` (implements
`MessageTransport`) and `tauriBleBridge()`:

```ts
const t = new BleTransport(await tauriBleBridge(), { onOpen, onClose, onFrame, onError });
await t.connect(contactEcdhSecret32, 30);   // scans up to 30 s for the paired phone, then connects
t.sendJson({ v: 1, kind: 'hello', /* ... */ });
```

Rust side (`apps/desktop/src-tauri/src/ble.rs`, commands in `lib.rs`):
`ble_capabilities`, `ble_connect`, `ble_write`, `ble_disconnect`; events arrive
on `duochat://ble` (`open` / `chunk` / `close` / `error`). `btleplug` is pinned to
`=0.13.5`.

## 12. Test checklist (all UNTESTED; run on real hardware)

1. Two Android phones (API 31+), internet off, paired earlier: both reach
   `onOpen`; hello handshake completes; a message each way arrives.
2. Android phone (peripheral) + Windows desktop (central), internet off.
3. A 20 KiB and a 64 KiB frame round-trip intact; MTU actually negotiated (log it).
4. Walk out of range and back: link closes, then reconnects without user action.
5. A third phone with a different contact never connects and never sees a
   DuoChat-identifiable advertisement (inspect with a generic BLE scanner app).
6. Tag rotation: leave the link down across an epoch boundary; reconnect works.
7. Android 8-11 device: scanning works with location on, fails with a clear error
   with location off.
8. Bluetooth turned off mid-session: clean close and a readable error.

## 13. What was and was not verified

| Piece | Status |
|---|---|
| Framing/reassembly (TS) | Unit-tested, shared vectors |
| Framing/reassembly + tag (Kotlin) | 8 JVM tests pass against the same vectors, compiled in a standalone Kotlin/JVM harness (not through the Android Gradle module, which needs the Android SDK); a deliberate one-byte mutation made them fail |
| `BleTransport` (TS) with a fake bridge | Unit-tested |
| `ble.rs` | Type-checks for `x86_64-pc-windows-msvc`; no unit tests run on Linux (btleplug needs libdbus); **never run against a radio** |
| Tauri command wiring | Type-checked in isolation only; the full Tauri crate could not be built in the authoring sandbox |
| `BleTransport.kt` (GATT) | **Not compiled, not run** |
| Range, throughput, privacy claims | **Not measured** |
