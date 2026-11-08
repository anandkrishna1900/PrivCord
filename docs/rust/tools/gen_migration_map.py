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
rule(r"protocol/src/signaling\.ts", "Manual signal codes, signaling frames, JWK validity", "domain (blob, JWK ported); signaling frames planned", "Domain", PARTIAL, "M4", "blob parse tested")
rule(r"protocol/src/peerAuth\.ts", "Legacy hello/auth_proof handshake, ack/read/ping frames", "engine::core (ack, ping ported); handshake replaced by secure channel", "Engine", PARTIAL, "M4: wire-compatible handshake for old clients", "engine tests")
rule(r"protocol/src/pairing\.ts", "Manual pairing codes", "engine (planned)", "Engine", TODO, "M4", "")
rule(r"protocol/src/killswitch\.ts", "Emergency erase plans and report", "engine::privacy service (planned)", "Engine", TODO, "M4", "")
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
rule(r"protocol/src/e2ee/x3dh\.ts", "Identity proof (used); X3DH bundles and prekeys (not used by the apps)", "crypto::identity (proof ported); X3DH not ported", "Crypto", PARTIAL, "Decide in M3b whether X3DH is kept; the apps do not call it", "proof vectors")
rule(r"protocol/src/e2ee/(ratchet|envelope|groupCrypto|index)\.ts", "Double Ratchet, envelopes, group keys (not used by the apps today)", "crypto (not ported)", "Crypto", TODO, "M3b, only if kept; needs its own security review", "")
rule(r"protocol/src/groups/(events|log)\.ts", "Group event log: signing, ids, deterministic fold, roster, 10-member cap", "crypto::group", "Crypto", PORTED, "M7/M8", "every TypeScript trace in docs/group-vectors.json, any arrival order")
rule(r"protocol/src/groups/coordinator\.ts", "Group coordinator: frames, introductions, sync, group messages", "engine::group (planned)", "Engine", TODO, "M4", "docs/group-vectors.json frames")
rule(r"protocol/src/mesh/channel\.ts", "Open channels", "domain::channel, crypto::channel", "Domain/Crypto", PORTED, "M7/M8", "vectors both ways")
rule(r"protocol/src/mesh/node\.ts", "Mesh flood, carry, dedupe, rate limit", "domain::mesh", "Domain", PORTED, "M7/M8", "simulation incl. flaky links")
rule(r"protocol/src/recovery/identity\.ts", "Recovery phrase, seed, derivation, identity", "crypto::identity", "Crypto", PORTED, "M7/M8", "vectors for 4 phrases")
rule(r"protocol/src/recovery/nistP256\.ts", "Hand-written P-256 scalar multiplication", "p256 crate", "Crypto", RETIRED, "Delete with the TypeScript package", "")
rule(r"protocol/src/recovery/index\.ts", "Re-exports", "n/a", "Tooling", RETIRED, "With the package", "")
# ---- desktop app
rule(r"desktop/src/lib/engine\.ts", "The whole desktop chat engine (identity, contacts, invites, groups, files, channels, social, backup, diagnosis)", "engine (identity, contacts, peers, messaging, delivery ported; groups, files, channels, invites, mesh, social, backup planned)", "Engine", PARTIAL, "M7 then M9", "engine integration tests")
rule(r"desktop/src/lib/(p2p|peerLink|network|ble|bleLink)(\.test)?\.ts", "WebRTC peer connection and BLE link on the desktop", "Transport adapters (stay); link policy moves to engine", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/bleFraming(\.test)?\.ts", "BLE chunk framing", "domain (planned: ble framing), vectors in docs/ble-vectors.json", "Domain", TODO, "M4")
rule(r"desktop/src/lib/localDb\.ts", "Desktop SQLite schema, encrypted columns, file store", "storage::SqliteStorage + importer (planned)", "Storage", PARTIAL, "M6b: importer for existing desktop databases, then delete", "storage tests")
rule(r"desktop/src/lib/(secureStore|encryption)\.ts", "Secure storage and at-rest encryption helpers", "SecureStore adapter (Tauri keyring)", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/identity\.ts", "Identity load and create", "crypto::identity + engine", "Engine", PORTED, "M7")
rule(r"desktop/src/lib/appLock\.ts", "WebAuthn app lock", "UI/adapter (stays)", "Adapter", ADAPTER, "Stays")
rule(r"desktop/src/lib/killSwitch.*\.ts", "Emergency erase executor", "engine::privacy service (planned) + platform erase adapters", "Engine/Adapter", TODO, "M4")
rule(r"desktop/src/lib/(outbox)(\.test)?\.ts", "Retry/outbox policy", "engine::core delivery", "Engine", PORTED, "M7", "engine tests")
rule(r"desktop/src/lib/signaling/.*", "Nostr events (BIP-340), relay client, signaling hub", "Signaling adapter now; rules planned as a Rust crate", "Engine/Adapter", TODO, "M4 (rules), adapter stays")
rule(r"desktop/src/lib/(notifications|clipboard\.test|clipboard|format|settings|settings\.test|themes|themes\.test)\.ts", "Presentation helpers, UI settings, themes, notifications bridge", "UI / adapter (stays)", "UI", UI, "Stays")
rule(r"desktop/src/(components|hooks)/.*", "React components and hooks", "UI", "UI", UI, "Stays; hooks become thin wrappers over Tauri commands in M7")
rule(r"desktop/src/(App|main|config|vite-env)\.tsx?|desktop/src/vite-env\.d\.ts", "App shell", "UI", "UI", UI, "Stays")
# ---- tauri
rule(r"src-tauri/src/(lib|main)\.rs", "Tauri shell: commands, keyring, notifications", "Desktop adapter + engine host", "Adapter", ADAPTER, "Stays; hosts the engine from M7")
rule(r"src-tauri/src/ble\.rs", "Native BLE central", "BLE adapter", "Adapter", ADAPTER, "Stays")
# ---- android
rule(r"android/.*/ui/.*", "Compose screens", "UI", "UI", UI, "Stays")
rule(r"android/.*/(MainActivity|DuoChatApp|AppConfig)\.kt", "Android shell", "UI / platform", "UI", UI, "Stays")
rule(r"android/.*/ble/(AndroidMeshRadio|BleEnvironment|BlePermissions|BleTransport|MeshRadio|SecureBleLink)\.kt", "Android Bluetooth radio, permissions, link", "BLE adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/ble/BleFraming\.kt", "BLE chunk framing", "domain (planned: ble framing)", "Domain", TODO, "M4")
rule(r"android/.*/ble/MeshNode\.kt", "Mesh flood logic", "domain::mesh", "Domain", PORTED, "M8")
rule(r"android/.*/data/(Diagnosis|Files|Privacy|NetworkConfig)\.kt", "Domain rules duplicated from TypeScript", "domain", "Domain", PORTED, "M8")
rule(r"android/.*/data/Social\.kt", "Delete/react frames, backup", "domain::social, crypto::backup", "Domain/Crypto", PORTED, "M8")
rule(r"android/.*/data/(Models|MessageStore|Preferences)\.kt", "Chat state models, in-memory store, preferences", "engine state + UI state", "Engine", PARTIAL, "M8")
rule(r"android/.*/data/Themes\.kt", "Themes", "UI", "UI", UI, "Stays")
rule(r"android/.*/data/local/DuoDatabase\.kt", "Room database", "storage::SqliteStorage + importer (planned)", "Storage", PARTIAL, "M6b: importer for existing Room databases, then delete")
rule(r"android/.*/engine/ChatEngine\.kt", "The whole Android chat engine", "engine", "Engine", PARTIAL, "M8 then M9", "engine integration tests")
rule(r"android/.*/engine/LinkPolicy\.kt", "Who connects out, backoff, scheduler", "engine::peer / connection manager (planned)", "Engine", TODO, "M5b")
rule(r"android/.*/groups/(GroupEvents|GroupLog)\.kt", "Group event log duplicated from TypeScript", "crypto::group", "Crypto", PORTED, "M8")
rule(r"android/.*/groups/GroupCoordinator\.kt", "Group coordinator", "engine::group (planned)", "Engine", TODO, "M4")
rule(r"android/.*/notifications/.*", "Notifications and background service", "Notifier adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/p2p/(IceServers|LinkTransport|WebRtcTransport)\.kt", "ICE servers, WebRTC data channel", "WebRTC adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/p2p/(PeerSession|Liveness|ManualSignal)\.kt", "Peer session, liveness, manual signal", "engine::peer (session ported; liveness and manual codes planned)", "Engine", PARTIAL, "M5b/M8")
rule(r"android/.*/security/(AndroidIdentity|LocalCrypto|AppLock)\.kt", "Keystore identity storage, at-rest encryption, biometric lock", "SecureStore adapter", "Adapter", ADAPTER, "Stays")
rule(r"android/.*/security/(Bip39|CanonicalJson|ContactCard|EcKeys|IdentityCodec|InviteCode|RecoveryIdentity|Seal|SecureChannel|SignatureCodec|Channels)\.kt", "Cryptography duplicated from TypeScript", "crypto", "Crypto", PORTED, "M8")
rule(r"android/.*/security/KillSwitch\.kt", "Emergency erase", "engine::privacy (planned)", "Engine", TODO, "M4")
rule(r"android/.*/signaling/.*", "Nostr, relay client, signaling hub", "Signaling adapter now; rules planned as a Rust crate", "Engine/Adapter", TODO, "M4")

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
