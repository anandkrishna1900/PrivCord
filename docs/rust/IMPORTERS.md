# Bringing an existing install over

`crates/privcord-import` moves an old install's data into the new storage. It does not trust the old data: every contact
card is re-verified (proof and uid), every group event is re-verified by the group log, message text and ids are checked
against the same rules as new messages, and file bytes must match their SHA-256. What fails is counted, with a reason,
and left behind.

## How it works

1. A *reader* turns the old database into a plain `LegacyBundle`.
   * **Desktop** (`desktop::read_bundle`): the SQLite file (`messages`, `outbox`, `meta`) and the 32-byte AES key the app
     keeps in the OS secret store (`enc1.<iv>.<ciphertext>`, AES-256-GCM, no associated data). Older databases without the
     later columns are read too. The browser-side file store (IndexedDB) cannot be read from Rust, so the app passes the
     file bytes through `FileSource`.
   * **Android** (`android::read_bundle`): the Room v7 file. Its AES key lives in the Android Keystore and can never be read
     out, so the app passes a `Decryptor` that calls the Keystore; Rust reads the rows and asks the app to decrypt each
     private value.
2. `import` checks the bundle and writes it in atomic batches, then a marker, last. Running it again does nothing
   (`already_done`); an interrupted run is simply run again, because contacts, messages and files are written without
   duplicating.
3. The facade offers `import_legacy_desktop` and `import_legacy_android`. Run them before starting the engine on the new
   database.

## What comes over and what does not

| Comes over | Left behind (counted as `skipped`) |
|---|---|
| contacts whose card verifies, with nickname, trust ("confirmed" from older builds counts as verified), checked flag, who introduced them | `contact_card_not_valid`, `contact_uid_mismatch` |
| groups, only the events that verify | `group_has_no_valid_events`, `group_event_not_valid` |
| joined channels (names normalised) | `channel_name_not_valid` |
| messages with replies, delivery state, read time, transport | `deleted_message` (only a tombstone was kept), `message_id_not_valid`, `message_text_not_valid`, `conversation_with_nobody_we_know`, `old_single_chat_with_several_friends` |
| file messages and their bytes | `file_bytes_missing`, `file_failed_its_hash_check` (the message itself still comes over) |
| unsent messages, still queued for the same people | |
| | **`reactions_not_kept`**: the message comes over, its reactions do not (the engine has no reactions yet) |

Muted people (`muted` flag) are read but not stored: the engine has no mute list yet.

## What has been tested, honestly

* Both readers and the importer run against databases built from `docs/legacy-fixtures.json`, made by
  `packages/protocol/scripts/gen-legacy-fixtures.ts`: real people and real signed group events from the protocol code, text
  encrypted the way the apps do it, and the apps' own table layouts (`localDb.ts`, `DuoDatabase.kt`).
* The tests cover: a wrong key (nothing imported), an old schema, a card with someone else's proof, a group with a changed
  event, a corrupt and a missing file, deleted and unreadable messages, running twice, and the new engine opening the result
  (same person recovered from the phrase, contacts, group, channel, messages, file, and unsent queue all present).
* A version-1 database of the new storage, with content, upgrades to the current version with a backup and nothing lost.

**Not done:** these are generated fixtures, not copies of a real phone or computer. Nobody has run the importer on a real
desktop `duochat.db` or an Android `duo.db` yet, and the Android Keystore decryptor does not exist in the app yet. Do both
before retiring any old persistence code (PRD section 16).
