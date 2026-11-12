#!/usr/bin/env python3
"""Generates docs/rust/MIGRATION_MAP.md (PRD milestone M0).

Every source file under the TypeScript protocol package, the desktop app, the Tauri shell and the Android app must match a
rule below, or this script fails: nothing may be left unmapped. Symbols are extracted automatically from the source; the
responsibility, destination, class and status columns are written by hand in RULES.

Run from the repository root:  python3 docs/rust/tools/gen_migration_map.py
"""
import re, sys, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parents[3]
AREAS = [
    ("Protocol package (TypeScript)", "packages/protocol/src", (".ts",)),
    ("Desktop app (TypeScript / React)", "apps/desktop/src", (".ts", ".tsx")),
    ("Desktop shell (Rust / Tauri)", "apps/desktop/src-tauri/src", (".rs",)),
    ("Android app (Kotlin)", "apps/android/app/src/main/java/com/duochat/app", (".kt",)),
]

# Status vocabulary
PORTED = "Ported, tested"
PARTIAL = "Partly ported"
TODO = "Not yet ported"
UI = "Stays (UI)"
ADAPTER = "Stays (platform adapter)"
RETIRED = "Replaced by a library"

# (regex on repo-relative path, responsibility, destination, class, status, removal condition)
R = []
def rule(pat, resp, dest, cls, status, removal="", tests=""):
    R.append((re.compile(pat), resp, dest, cls, status, removal, tests))

# ---- protocol package
rule(r"protocol/src/constants\.ts", "Fixed limits and defaults", "domain::limits, domain::network", "Domain", PORTED, "When desktop and Android call the Rust engine (M7, M8)", "domain unit + vectors")
rule(r"protocol/src/message\.ts", "Message model, text rules, reply refs, peer message frame, declined frame", "domain::message", "Domain", PORTED, "M7/M8", "domain vectors, properties")
rule(r"protocol/src/ordering\.ts", "Message order and merge", "domain::ordering", "Domain", PORTED, "M7/M8", "properties")
rule(r"protocol/src/states\.ts", "Connection states and header presentation", "domain::state", "Domain", PORTED, "M7/M8", "domain unit")
rule(r"protocol/src/privacy\.ts", "Group-only direct-message rule", "domain::privacy", "Domain", PORTED, "M7/M8", "vectors")
rule(r"protocol/src/social\.ts", "Delete and react frames, reaction chips", "domain::social", "Domain", PORTED, "M7/M8", "vectors")
rule(r"protocol/src/files\.ts", "File offers, chunks, sanitising, assembler", "domain::files", "Domain", PORTED, "M7/M8", "vectors, properties")
rule(r"protocol/src/backup\.ts", "Encrypted backup format", "crypto::backup", "Crypto", PORTED, "M7/M8", "vectors both ways")
rule(r"protocol/src/safetyNumber\.ts", "Safety numbers", "crypto::safety", "Crypto", PORTED, "M7/M8", "vector")
rule(r"protocol/src/signaling\.ts", "Manual connection codes, JWK validity", "domain::signaling, domain::pairing::is_valid_public_jwk", "Domain", PORTED, "M7/M8", "docs/misc-vectors.json: every decode error and a code each way")
rule(r"protocol/src/peerAuth\.ts", "Legacy hello/auth_proof/auth_ok handshake; ack, read, ping, pong frames", "crypto::peer_auth, domain::peer; engine::core (LinkSecurity::TransportEncrypted)", "Crypto/Engine", PORTED, "M7/M8", "TypeScript transcript accepted in Rust and Rust transcript accepted by TypeScript checks; engine tests")
rule(r"protocol/src/pairing\.ts", "Saved pairing records, reconnect backoff", "domain::pairing", "Domain", PORTED, "M7/M8", "docs/misc-vectors.json: parse cases, status table, delays; Rust output read by TypeScript")
rule(r"protocol/src/killswitch\.ts", "Emergency erase plans, report and runner", "domain::killswitch; engine::core::privacy (executor)", "Domain/Engine", PORTED, "M7/M8", "docs/misc-vectors.json: plans, every summary case, a run and a resume; engine lifecycle tests")
rule(r"protocol/src/index\.ts", "Re-exports", "n/a", "Tooling", RETIRED, "With the package", "")
rule(r"protocol/src/connectivity/connectionPath\.ts", "Classify the selected ICE pair", "domain::state", "Domain", PORTED, "M7/M8", "domain unit")
rule(r"protocol/src/connectivity/contactCard\.ts", "Contact card encode, decode, verify", "crypto::card", "Crypto", PORTED, "M7/M8", "vectors byte-identical")
rule(r"protocol/src/connectivity/diagnosis\.ts", "Why isn't it connecting", "domain::diagnosis", "Domain", PORTED, "M7/M8", "domain unit")
rule(r"protocol/src/connectivity/inviteCode\.ts", "Six-word invites", "crypto::invite", "Crypto", PORTED, "M7/M8", "vectors both ways")
rule(r"protocol/src/connectivity/networkConfig\.ts", "Network settings parsing", "domain::network", "Domain", PORTED, "M7/M8", "domain unit")
rule(r"protocol/src/connectivity/secureChannel\.ts", "Link encryption handshake and frames", "crypto::secure_channel", "Crypto", PORTED, "M7/M8", "byte-for-byte frame vectors")
rule(r"protocol/src/connectivity/seal\.ts", "Sealed blobs, mailbox ids", "crypto::seal, domain::blob", "Crypto", PORTED, "M7/M8", "vectors both ways")
rule(r"protocol/src/connectivity/turnShare\.ts", "Relay setup line", "domain::network", "Domain", PORTED, "M7/M8", "vector")
rule(r"protocol/src/e2ee/primitives\.ts", "WebCrypto wrappers, base64url, canonical JSON", "crypto::{aead,kdf,canonical}, domain::codec", "Crypto", PORTED, "M7/M8", "vectors")
rule(r"protocol/src/e2ee/x3dh\.ts", "Identity proof, X3DH bundles, prekeys and key agreement", "crypto::e2ee::x3dh (identity proof in crypto::identity)", "Crypto", PORTED, "M7/M8", "docs/e2ee-vectors.json: bundle verdicts and messages, responder derives the TypeScript secret; Rust-made sessions read by TypeScript")
rule(r"protocol/src/e2ee/(ratchet|envelope|groupCrypto|index)\.ts", "Double Ratchet, envelopes, epoch-keyed group messages", "crypto::e2ee::{ratchet,envelope,group_crypto}", "Crypto", PORTED, "M7/M8", "docs/e2ee-vectors.json: TypeScript conversations (out of order, replay, tamper, restart) read by Rust; Rust conversations read by TypeScript")
rule(r"protocol/src/groups/(events|log)\.ts", "Group event log: signing, ids, deterministic fold, roster, 10-member cap", "crypto::group", "Crypto", PORTED, "M7/M8", "every TypeScript trace in docs/group-vectors.json, any arrival order")
rule(r"protocol/src/groups/coordinator\.ts", "Group coordinator: frames, introductions, sync, gossip, group messages", "crypto::group_coordinator; engine::core groups (sync on link-up, fan-out, persistence)", "Engine", PORTED, "M7/M8", "TypeScript frame vectors; scenarios; three-engine tests; relay_blob frames are parsed but not relayed by the engine")
rule(r"protocol/src/mesh/channel\.ts", "Open channels", "domain::channel, crypto::channel", "Domain/Crypto", PORTED, "M7/M8", "vectors both ways")
rule(r"protocol/src/mesh/node\.ts", "Mesh flood, carry, dedupe, rate limit", "domain::mesh", "Domain", PORTED, "M7/M8", "simulation incl. flaky links")
rule(r"protocol/src/recovery/identity\.ts", "Recovery phrase, seed, derivation, identity", "crypto::identity", "Crypto", PORTED, "M7/M8", "vectors for 4 phrases")
rule(r"protocol/src/recovery/nistP256\.ts", "Hand-written P-256 scalar multiplication", "p256 crate", "Crypto", RETIRED, "Delete with the TypeScript package", "")
rule(r"protocol/src/recovery/index\.ts", "Re-exports", "n/a", "Tooling", RETIRED, "With the package", "")
# ---- desktop app
rule(r"desktop/src/lib/engine\.ts", "The desktop chat engine", "engine: every rule, the chat list (last message, unread, delivery detail), group views, search, backups, invites, signaling, groups, files, channels, mesh, deletion. Left in TypeScript: starting and driving the WebRTC links and the Bluetooth bridge, turning events into screen state, notices and toasts, settings", "Engine/Adapter", PARTIAL, "M7: rewire onto the engine; the WebRTC and Bluetooth driving becomes the adapter", "engine integration tests")
rule(r"desktop/src/lib/(p2p|peerLink|network|ble|bleLink)(\.test)?\.ts", "WebRTC peer connection and BLE link on the desktop", "Transport adapters (stay); link policy moves to engine", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/bleFraming(\.test)?\.ts", "BLE chunk framing and rotating tags", "domain::ble, crypto::ble", "Domain", PORTED, "M7/M8", "docs/ble-vectors.json: chunking, every reassembly error, 64 KiB, tags")
rule(r"desktop/src/lib/localDb\.ts", "Desktop SQLite schema, encrypted columns, file store", "storage::SqliteStorage; privcord-import (desktop importer)", "Storage", PORTED, "M7: after the importer has run on every install", "importer and migration tests on generated fixtures (docs/legacy-fixtures.json); the browser file store stays in the adapter")
rule(r"desktop/src/lib/(secureStore|encryption)\.ts", "Secure storage and at-rest encryption helpers", "SecureStore adapter (Tauri keyring)", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/identity\.ts", "Identity load and create", "crypto::identity + engine", "Engine", PORTED, "M7")
rule(r"desktop/src/lib/appLock\.ts", "WebAuthn app lock", "UI/adapter (stays)", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/killSwitch.*\.ts", "Emergency erase steps for the webview (local storage, IndexedDB, files, Tauri commands)", "engine::core::privacy runs the plan and the report; these files only call web and OS APIs", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/(outbox)(\.test)?\.ts", "Retry/outbox policy", "engine::core delivery", "Engine", PORTED, "M7", "engine tests")
rule(r"desktop/src/lib/signaling/.*", "Nostr events (BIP-340), relay client, signaling hub", "engine::signaling::{relay,nostr,hub} (state machines) + crypto::nostr; a socket adapter of a few lines remains", "Engine/Adapter", PORTED, "M7: replace with the socket adapter that feeds SignalingHub", "relay client against the real relay (tests/real_relay.rs); fake relays for backoff, timeouts, dedupe, Nostr rules")
rule(r"desktop/src/lib/(notifications|clipboard\.test|clipboard|format|settings|settings\.test|themes|themes\.test)\.ts", "Presentation helpers, UI settings, themes, notifications bridge", "UI / adapter (stays)", "UI", UI, "Stays")
rule(r"desktop/src/(components|hooks)/.*", "React components and hooks", "UI", "UI", UI, "Stays; hooks become thin wrappers over Tauri commands in M7")
rule(r"desktop/src/(App|main|config|vite-env)\.tsx?|desktop/src/vite-env\.d\.ts", "App shell", "UI", "UI", UI, "Stays")
# ---- tauri
rule(r"src-tauri/src/(lib|main)\.rs", "Tauri shell: commands, keyring, notifications", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; hosts the engine from M7")
rule(r"src-tauri/src/ble\.rs", "Native BLE central", "BLE adapter", "Adapter", ADAPTER, "Stays")
rule(r"src-tauri/src/engine_host\.rs", "Hosts the Rust engine in the shell: keyring secret store, events to the page", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; M7 seam (page not rewired yet)")
rule(r"desktop/src/lib/engineBridge(\.test)?\.ts", "Page side of the hosted engine: ordered inbound calls, Busy retry, Tauri events", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; M7 seam (page not rewired yet)")
rule(r"desktop/src/lib/engineApi\.ts", "The interface the screens use to talk to a chat engine (TypeScript or Rust)", "Platform seam (stays)", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/hosted/(shape)(\.test)?\.ts", "Shapes the Rust engine's snapshot into the screens' state", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; tested on a real engine snapshot")
rule(r"desktop/src/lib/hosted/(runtime)(\.test)?\.ts", "WebRTC and relay adapters for the hosted engine", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/hosted/(hostedEngine|start|enable|legacyIdentity)\.ts", "The desktop chat engine on the Rust engine: commands, state, identity migration, the on/off switch", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; opt-in until M9")
rule(r"desktop/src/lib/hosted/e2e\.test\.ts", "End to end: two hosted engines on real Rust engine processes", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays")
# ---- android
rule(r"android/.*/ui/.*", "Compose screens", "UI", "UI", UI, "Stays")
rule(r"android/.*/rustcore/.*\.kt", "Android adapters for the Rust engine (Keystore secret store, on-device probe)", "Platform adapter for engine ports", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/(MainActivity|DuoChatApp|AppConfig|RustCore)\.kt", "Android shell and the loader for the Rust core", "UI / platform", "UI", UI, "Stays")
rule(r"android/.*/ble/(AndroidMeshRadio|BleEnvironment|BlePermissions|BleTransport|MeshRadio|SecureBleLink)\.kt", "Android Bluetooth radio, permissions, link", "BLE adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/ble/BleFraming\.kt", "BLE chunk framing", "domain::ble", "Domain", PORTED, "M8", "docs/ble-vectors.json")
rule(r"android/.*/ble/MeshNode\.kt", "Mesh flood logic", "domain::mesh", "Domain", PORTED, "M8")
rule(r"android/.*/data/(Diagnosis|Files|Privacy|NetworkConfig)\.kt", "Domain rules duplicated from TypeScript", "domain", "Domain", PORTED, "M8")
rule(r"android/.*/data/Social\.kt", "Delete/react frames, backup", "domain::social, crypto::backup", "Domain/Crypto", PORTED, "M8")
rule(r"android/.*/data/(Models|MessageStore)\.kt", "Chat state models and the in-memory message store over Room", "engine state (snapshot, events) and storage::SqliteStorage", "Engine", PORTED, "M8: the engine owns this state", "engine and storage tests")
rule(r"android/.*/data/Preferences\.kt", "App settings storage", "UI state (stays)", "UI", UI, "Stays")
rule(r"android/.*/data/Themes\.kt", "Themes", "UI", "UI", UI, "Stays")
rule(r"android/.*/data/local/DuoDatabase\.kt", "Room database", "storage::SqliteStorage; privcord-import (Room importer, Keystore decryptor supplied by the app)", "Storage", PORTED, "M8: after the importer has run on every install", "importer tests on generated Room v7 fixtures")
rule(r"android/.*/engine/ChatEngineApi\.kt", "The interface the screens use to talk to a chat engine (the Rust engine)", "Platform seam (stays)", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/engine/EngineHost\.kt", "Keeps the running engine in the process so it outlives the screen", "Platform seam (stays)", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/notifications/.*", "Notifications and background service", "Notifier adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/p2p/(IceServers|LinkTransport|WebRtcTransport)\.kt", "ICE servers, WebRTC data channel", "WebRTC adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/p2p/Liveness\.kt", "Liveness probe", "domain::link_policy, domain::signaling; engine::core (ping, dead-link timer)", "Engine", PORTED, "M8", "misc vectors; engine lifecycle tests")
rule(r"android/.*/p2p/PeerSession\.kt", "WebRTC peer session (handshake, receipts, liveness and framing rules are in the engine)", "crypto::peer_auth + engine; the WebRTC session itself is platform code", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/security/(AndroidIdentity|LocalCrypto|AppLock)\.kt", "Keystore identity storage, at-rest encryption, biometric lock", "SecureStore adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/security/(Bip39|CanonicalJson|ContactCard|EcKeys|IdentityCodec|InviteCode|RecoveryIdentity|Seal|SecureChannel|SignatureCodec|Channels)\.kt", "Cryptography duplicated from TypeScript", "crypto", "Crypto", PORTED, "M8")
rule(r"android/.*/security/KillSwitch\.kt", "Emergency erase steps for Android (Keystore key, files, Room)", "domain::killswitch + engine::core::privacy run the plan; these steps call Android APIs", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/signaling/Schnorr\.kt", "Hand-written BIP-340 Schnorr", "k256 crate (crypto::nostr)", "Crypto", RETIRED, "Delete with the Kotlin app's signaling")
rule(r"android/.*/signaling/.*", "Nostr, relay client, signaling hub", "engine::signaling (state machines) + crypto::nostr; a socket adapter remains", "Engine/Adapter", PORTED, "M8: replace with the socket adapter that feeds SignalingHub", "same tests as the desktop clients")

def symbols(path: pathlib.Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    names = []
    if path.suffix in (".ts", ".tsx"):
        names = re.findall(r"^export\s+(?:async\s+)?(?:default\s+)?(?:function\*?|class|const|interface|type|enum)\s+([A-Za-z0-9_]+)", text, re.M)
        if path.name.endswith("engine.ts"):
            names += [m for m in re.findall(r"^  (?:async )?([a-zA-Z0-9_]+)\(", text, re.M)[:0]]
    elif path.suffix == ".kt":
        names = re.findall(r"^(?:internal |private |public )?(?:data |sealed |enum |open |abstract )?(?:class|object|interface|fun)\s+(?:[A-Za-z<>?., ]+\.)?([A-Za-z0-9_]+)", text, re.M)
    elif path.suffix == ".rs":
        names = re.findall(r"^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum)\s+([A-Za-z0-9_]+)", text, re.M)
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n); out.append(n)
    return out

def main():
    rows, unmapped = [], []
    for area, base, exts in AREAS:
        for p in sorted((ROOT / base).rglob("*")):
            if not p.is_file() or p.suffix not in exts:
                continue
            rel = p.relative_to(ROOT).as_posix()
            for pat, resp, dest, cls, status, removal, tests in R:
                if pat.search(rel):
                    break
            else:
                unmapped.append(rel); continue
            loc = len(p.read_text(encoding="utf-8", errors="replace").splitlines())
            syms = symbols(p)
            shown = ", ".join(f"`{s}`" for s in syms[:6]) + (f" +{len(syms)-6}" if len(syms) > 6 else "")
            rows.append((area, rel, loc, shown or "(none)", resp, dest, cls, status, removal, tests))
    if unmapped:
        print("UNMAPPED FILES (add a rule):", *unmapped, sep="\n  ")
        sys.exit(1)
    count = collections.Counter(r[7] for r in rows)
    loc_by = collections.Counter()
    for r in rows:
        loc_by[r[7]] += r[2]
    total = sum(loc_by.values())
    out = ["# M0: source-to-Rust migration map", "",
           "Generated by `docs/rust/tools/gen_migration_map.py`; the script fails if any source file is not covered by a rule, so nothing is left unmapped. "
           "Symbols are extracted automatically; responsibility, destination and status are written by hand next to the rules in that script and reviewed with each milestone.", "",
           "Status meanings: **Ported, tested** = the Rust implementation exists and is checked against TypeScript or Kotlin output; **Partly ported** = some of the file's responsibilities are in Rust; "
           "**Not yet ported** = still only in TypeScript or Kotlin; **Stays** = UI or platform adapter code that is meant to remain; **Replaced by a library** = a hand-written routine that a vetted crate replaces.", "",
           "## Summary", "", "| Status | Files | Lines |", "|---|---:|---:|"]
    for s in (PORTED, PARTIAL, TODO, UI, ADAPTER, RETIRED):
        out.append(f"| {s} | {count[s]} | {loc_by[s]} |")
    out.append(f"| **All mapped files** | **{len(rows)}** | **{total}** |")
    out += ["", "Ported does not mean retired: the TypeScript and Kotlin versions stay in production until the apps call the Rust engine (M7 desktop, M8 Android) and the compatibility gates pass (PRD section 16).", ""]
    for area, *_ in AREAS:
        out += [f"## {area}", "", "| File | Lines | Main symbols | Current responsibility | Destination | Class | Status | Removal condition | Tests |", "|---|---:|---|---|---|---|---|---|---|"]
        for r in rows:
            if r[0] == area:
                out.append("| `{}` | {} | {} | {} | {} | {} | {} | {} | {} |".format(r[1].split("/", 1)[1] if False else r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8] or "n/a", r[9] or "n/a"))
        out.append("")
    (ROOT / "docs/rust/MIGRATION_MAP.md").write_text("\n".join(out), encoding="utf-8")
    print(f"mapped {len(rows)} files, {total} lines")
    for s in (PORTED, PARTIAL, TODO, UI, ADAPTER, RETIRED):
        print(f"  {s}: {count[s]} files, {loc_by[s]} lines")

main()
