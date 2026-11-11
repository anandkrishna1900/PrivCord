# M7 (Windows desktop) and M9 (retirement): plan and exit criteria

Status of the port on 11 Nov 2026: the Rust engine exists and is tested; the Android **rust** build flavor runs on it as a
preview; the **Windows app still runs on its own TypeScript engine** (`apps/desktop/src/lib/engine.ts`, 2,161 lines, marked
"partly ported" in [MIGRATION_MAP.md](MIGRATION_MAP.md)). This file says what moving the desktop onto the engine involves,
and what has to be true before any old engine is deleted. It is a plan, not a record of work done.

## Done so far (the seam, not the switch)

* `crates/privcord-desktop-host`: the engine behind a JSON command/event interface (`invoke`, `next_event`), no Tauri code. Tested by
  two hosted engines that pair, connect over an in-memory link and exchange a message using only that interface.
* `privcord-ffi` has an optional `serde` feature so snapshots and events can be turned into JSON.
* `apps/desktop/src-tauri/src/engine_host.rs`: Tauri commands `engine_start`, `engine_invoke`, `engine_stop`; the identity's
  secrets in Windows Credential Manager; events to the page (`privcord://frame`, `privcord://signal-put`, ...). Compiles on
  Linux and Windows CI. **Nothing in the app calls it yet.**
* `apps/desktop/src/lib/engineBridge.ts`: the page side, with strictly ordered inbound calls and a retry while the engine is busy.
* The shell and the engine now share one SQLite build: `rusqlite` was moved from 0.41 to 0.31 so it links the same
  `libsqlite3-sys` as `tauri-plugin-sql`. (Two copies of the native library cannot be linked.) When `tauri-plugin-sql` is
  removed (the engine owns the database) this can move forward again.

**Not done:** the page still runs on `engine.ts`; only a handful of commands are exposed (identity, contacts, invites, messages,
links, signaling, snapshot); files, groups, channels, search, backup, wipe and the rest need adding as the page moves over;
the WebRTC and relay adapters in the page are not written; nothing has run on Windows.

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
