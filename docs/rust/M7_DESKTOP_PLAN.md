# M7 (Windows desktop) and M9 (retirement): plan and exit criteria

Status of the port on 11 Nov 2026: the Rust engine exists and is tested; the Android **rust** build flavor runs on it as a
preview; the **Windows app still runs on its own TypeScript engine** (`apps/desktop/src/lib/engine.ts`, 2,161 lines, marked
"partly ported" in [MIGRATION_MAP.md](MIGRATION_MAP.md)). This file says what moving the desktop onto the engine involves,
and what has to be true before any old engine is deleted. It is a plan, not a record of work done.

## Done so far (the Rust engine is the default in the packaged app; the TypeScript engine stays as a fallback)

* `crates/privcord-desktop-host`: the engine behind a JSON command/event interface (`invoke`, `next_event`), no Tauri code: identity,
  contacts, six-word invites, messages, files, groups, channels, reactions, delete, search, backup, wipe, links, signaling.
  `examples/host_stdio.rs` runs it as a separate process, standing in for the shell in tests.
* `apps/desktop/src-tauri/src/engine_host.rs`: Tauri commands `engine_start`, `engine_invoke`, `engine_stop`,
  `engine_seed_identity`; the identity's secrets in Windows Credential Manager; engine-to-page events. Compiles on Linux and in
  Windows CI.
* **Page adapters** (`apps/desktop/src/lib/hosted/runtime.ts`): WebRTC links (offer/answer through the engine's signals, ordered
  outbound frames that wait while the channel is full, ordered inbound calls with a retry while the engine is busy) and the relay
  sockets (one per mailbox, puts wait for an online socket, the page opens its own mailbox itself because the engine subscribes
  before the page is listening). Same lessons as the Android adapter.
* **`HostedChatEngine`** (`hosted/hostedEngine.ts`): the same `ChatEngineApi` the TypeScript `ChatEngine` implements
  (`lib/engineApi.ts`; the screens now depend on the interface), shaping the engine's snapshot into the screens' state
  (`hosted/shape.ts`, tested on a real recorded snapshot).
* **Bluetooth** (`runtime.ts`): the page scans with the tags worked out from the engine's per-friend secret, cuts and reassembles
  radio chunks, and reports the link as "layered", so the **engine** runs the encrypted handshake (tested end to end over a fake
  radio against real engine processes). The same Bluetooth shell code (`ble.rs`) as before; Windows can only scan, so a phone
  must be the other side. **Never tried on a real radio.**
* **Manual connection codes**: the same `DUO1:` format the old engine and the classic Android app use, made and checked in the
  page (signed identity parts, "is this from a friend", "is this an offer or an answer"). Tested end to end.
* **The default**: the packaged app runs the Rust engine. Settings > Connection > Advanced > "Run on the Rust engine" turns it off
  to use the older TypeScript engine (the app restarts). The browser build always uses the TypeScript engine (no shell to host the
  engine). The existing identity is carried over to the engine on first use (verified: it derives to the same user id), so nobody
  re-enters their phrase.
* **Tests**: unit tests for the shaping and the adapters; an end-to-end test (`hosted/e2e.test.ts`, run in CI) with two real Rust
  engine processes driven through the same class the screens use: add each other, connect, message and delivery state, a file byte
  for byte, search, reaction, group and group message.
* The shell and the engine share one SQLite build: `rusqlite` moved from 0.41 to 0.31 so it links the same `libsqlite3-sys` as
  `tauri-plugin-sql`. It can move forward once that plugin is removed.

**Not done**
* Nothing has run on Windows: the packaged app, a real WebRTC link, Windows Credential Manager, the emergency wipe through the
  engine, the lock screen with this mode on.
* **Old chats do not appear in this mode.** The engine keeps its own database; `privcord-import` has not been wired to read the old
  desktop database into it. (The recovery-phrase identity does carry over.)
* The wipe dialogs call the engine's wipe through a stand-in store; the full report is not shown.
* Search in the screens scans what is on screen rather than asking the engine.
* The old engine and its local store are still shipped (as the fallback); nothing was deleted. The default was switched because
  nobody was using the app; it should not have been switched for people with chats they care about without the import above.

## Why this is not a quick job

* The desktop UI is a web page (React in a Tauri webview). WebRTC lives **in the webview**; Bluetooth, SQLite and secure storage
  live in **Rust in the Tauri shell** (`apps/desktop/src-tauri/src`: `lib.rs`, `ble.rs`). The engine would sit in the shell, so
  every WebRTC event has to cross the webview/shell boundary and back, in order.
* It can only be built and checked on Windows (installer, Windows Hello, Credential Manager, Bluetooth search), which the CI
  covers for compiling but not for behaviour.
* The desktop has an end-to-end browser suite (`apps/desktop/e2e`) that exercises the TypeScript engine in real browsers. It
  has to keep passing, or be rebuilt against the new path, before the TypeScript engine can go.

## Design (what M7 should do)

1. **Host the engine in the Tauri shell.** A new module in `src-tauri` starts `privcord-engine` with the real ports:
   `privcord-storage` (SQLite) for `Storage`, Windows Credential Manager for `SecureStore`, a transport that forwards frames to
   the webview, and the system clock. This mirrors what `privcord-ffi` does for Android.
2. **Commands and events over Tauri.** Expose the engine's typed commands (`create_identity`, `add_contact`, `send_message`,
   `snapshot`, ...) as Tauri commands and push engine events (`MessageAdded`, `DialRequested`, `SignalReceived`, `FileProgress`,
   `FileIncoming`, `FileQueued`, ...) to the webview as Tauri events. Reuse the **snapshot** as the single source of screen state,
   as `RustChatEngine` does.
3. **Keep WebRTC in the webview as the adapter.** `p2p.ts` / `peerLink.ts` stay, but become thin: open a data channel when the
   engine emits `DialRequested`, call `link_up` / `frame_received` / `link_down` on the engine, send what the engine hands the
   transport. Frames must reach the engine **in order** with back-pressure (the Android adapter learned this the hard way:
   an ordered inbound queue, retry on `Busy`, a per-peer outbound queue that waits while the channel buffer is full).
4. **Signaling sockets** (Nostr, relay) move to a shell-side or webview-side adapter that feeds `signal_blob` and implements
   `signal_put` / `signal_subscribe`; one connection per mailbox, put-queueing until a relay is online (also an Android lesson).
5. **Bluetooth** keeps using `ble.rs`, with `LinkKind::Layered` so the engine speaks the same layered handshake the apps use.
6. **Data migration** with `privcord-import` from the existing desktop SQLite database, on a **copy**, with a verified report and a
   one-click way back.
7. **Remove, last:** once the above passes, delete `engine.ts` and the TypeScript protocol code the engine replaced.

## Exit criteria

### Before the desktop switches to the engine
- [ ] The engine hosted in the shell passes the existing desktop end-to-end suite (pairing, messages, groups, files, channels,
      invites, backup/restore) with the WebRTC adapter in the loop.
- [ ] A Windows machine test: install, create identity, add a friend, message, send an 8 MB file, lock/unlock with Windows Hello,
      wipe. Run on a clean machine, not a developer's.
- [ ] A Windows <-> Android (Rust flavor) test over the internet and over Bluetooth.
- [ ] `privcord-import` has read a **real** desktop database (a copy of a real user's), with the report checked by hand.
- [ ] Frame ordering and back-pressure tests for the webview/shell boundary (large file, slow link, link dropped mid-transfer).

### Retirement (M9)
Nothing old is deleted until **all** of these hold:
- [ ] Both apps run on the engine in normal use for a stated period (suggest 4 weeks of real use by several people), with no data-loss
      or connection regressions open.
- [ ] Android: the **rust** flavor has been run on a matrix of real phones (several Android versions and makers), on the same Wi-Fi,
      across networks with a TURN relay, in the background for hours, and over Bluetooth. Groups of 3 to 6 on real phones.
- [ ] `privcord-import` has read real Android Room data from a real phone, and a user's old chats arrive intact.
- [ ] The shared vectors (`docs/*-vectors.json`) still pass in all directions; they are the thing that keeps the protocol stable
      after the old engines are gone.
- [ ] A way back: the previous release stays downloadable for a stated time.
- [ ] An independent security review of the engine and the adapters has been done, or the project says plainly in its README that
      it has not.

Then, in order: delete `apps/android/.../engine/ChatEngine.kt` and the Kotlin protocol code it uses (keep the adapters: WebRTC,
Bluetooth, signaling sockets, Keystore); delete `apps/desktop/src/lib/engine.ts` and the TypeScript protocol code the engine
replaced (keep `packages/protocol` only if something still needs it as a test oracle); regenerate
[MIGRATION_MAP.md](MIGRATION_MAP.md) so every file is "ported", "stays" or "replaced by a library".

## What can be done without a Windows machine or phones

* Specify and test the shell-side engine host on Linux in CI (compiles, runs the engine with in-memory ports).
* Build the webview adapter against the real engine in a headless browser (the e2e suite already does this style of test).
* Keep fixing what real-phone testing of the Android rust flavor turns up; that is the most valuable work for M8.

## What cannot be done from the code alone

Real-device and real-network results, real-data import checks, Windows-specific behaviour, store and signing steps, and the
decision to delete the old engines. Those need people, devices and time.
