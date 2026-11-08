//! The desktop app's SQLite file (`localDb.ts`): `messages`, `outbox` and `meta` tables; text encrypted with the local AES
//! key (`encryption.ts`, `enc1.<iv>.<ciphertext>`, base64url, no associated data). Contacts, groups, channels and muted
//! people are small encrypted JSON values in `meta` under `secret.<name>`.

use crate::{
    contacts_from_json, file_meta_from, parse_delivery, reactions_from, reply_from, Decryptor,
    LegacyBundle, LegacyMessage, ReadError,
};
use privcord_crypto::aead;
use privcord_domain::{codec, message::TransportKind};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::{collections::HashSet, path::Path};

const PREFIX: &str = "enc1.";

/// Decrypts with the desktop's local AES-256-GCM key (the 32 bytes the app keeps in the OS secret store).
pub struct AesKeyDecryptor(pub [u8; 32]);

impl std::fmt::Debug for AesKeyDecryptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AesKeyDecryptor(..)")
    }
}

impl Decryptor for AesKeyDecryptor {
    fn text(&self, payload: &str) -> Option<String> {
        let Some(rest) = payload.strip_prefix(PREFIX) else {
            return Some(payload.to_owned()); // never encrypted (the app returns it unchanged too)
        };
        let (iv, ct) = rest.split_once('.')?;
        let plain = aead::decrypt(&self.0, &codec::decode(iv)?, &codec::decode(ct)?, &[]).ok()?;
        String::from_utf8(plain).ok()
    }
}

/// File bytes at rest in the desktop app: 12-byte IV then the AES-GCM ciphertext.
pub fn decrypt_file_bytes(key: &[u8; 32], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 29 {
        return None;
    }
    let (iv, ct) = payload.split_at(12);
    aead::decrypt(key, iv, ct, &[]).ok()
}

pub(crate) fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>, ReadError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| ReadError::Database)?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| ReadError::Database)?
        .filter_map(Result::ok)
        .collect();
    Ok(names)
}

fn secret(conn: &Connection, dec: &dyn Decryptor, name: &str) -> Option<Value> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [format!("secret.{name}")],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    serde_json::from_str(&dec.text(&raw?)?).ok()
}

/// Reads everything importable from a desktop database. Rows that cannot be decrypted or understood are left out here
/// (the importer counts what it rejects; what cannot even be read is not in the bundle).
pub fn read_bundle(db_path: &Path, dec: &dyn Decryptor) -> Result<LegacyBundle, ReadError> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| ReadError::Database)?;
    let msg_cols = columns(&conn, "messages")?;
    if msg_cols.is_empty() {
        return Err(ReadError::NotPrivcord);
    }
    let mut bundle = LegacyBundle::default();

    // Contacts, groups, channels, muted people.
    let mut muted: HashSet<String> = HashSet::new();
    if let Some(Value::Array(list)) = secret(&conn, dec, "blocked") {
        muted.extend(list.iter().filter_map(|v| v.as_str().map(str::to_owned)));
    }
    if let Some(Value::Array(list)) = secret(&conn, dec, "contacts") {
        bundle.contacts = contacts_from_json(&list, &muted);
    }
    bundle.muted = muted.iter().cloned().collect();
    bundle.muted.sort();
    if let Some(Value::Object(groups)) = secret(&conn, dec, "groups") {
        for (id, events) in groups {
            if let Value::Array(events) = events {
                bundle.groups.insert(id, events);
            }
        }
    }
    if let Some(Value::Array(names)) = secret(&conn, dec, "channels") {
        bundle
            .channels
            .extend(names.iter().filter_map(|n| n.as_str().map(str::to_owned)));
    }

    // Messages. Older databases lack some columns: treat them as empty.
    let col = |name: &str| {
        if msg_cols.contains(name) {
            name.to_owned()
        } else {
            format!("NULL AS {name}")
        }
    };
    let sql = format!(
        "SELECT message_id, client_message_id, sender_id, text_cipher, client_created_at, message_type, transport, \
         delivery_state, read_at, {}, {}, {} FROM messages",
        col("conversation_id"),
        col("recips"),
        col("extra_cipher")
    );
    let mut stmt = conn.prepare(&sql).map_err(|_| ReadError::Database)?;
    type Row = (
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
                r.get(11)?,
            ))
        })
        .map_err(|_| ReadError::Database)?;
    let mut pending_by_message = outbox_pending(&conn);
    for row in rows.filter_map(Result::ok) {
        let row: Row = row;
        let (id, client_id, sender, text_cipher, created_at, kind, transport, delivery, read_at) = (
            row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
        );
        let (conversation, recips, extra_cipher) = (row.9, row.10, row.11);
        let Some(text) = dec.text(&text_cipher) else {
            continue; // the app shows "[unable to decrypt...]" here; there is nothing to import
        };
        let extra: Value = extra_cipher
            .as_deref()
            .and_then(|c| dec.text(c))
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let file = if kind == "file" {
            file_meta_from(extra.get("file"))
        } else {
            None
        };
        // Group messages keep who is still pending in `recips`; direct ones in the outbox table.
        let mut pending = pending_by_message.remove(&id).unwrap_or_default();
        if let Some(Value::Object(r)) = recips.as_deref().and_then(|t| serde_json::from_str(t).ok())
        {
            for (uid, state) in r {
                if matches!(state.as_str(), Some("QUEUED" | "SENT" | "FAILED"))
                    && !pending.iter().any(|(u, _)| *u == uid)
                {
                    pending.push((uid, 0));
                }
            }
        }
        let Some(delivery) = parse_delivery(&delivery) else {
            continue;
        };
        bundle.messages.push(LegacyMessage {
            id,
            client_id,
            sender,
            text,
            created_at,
            conversation: conversation.unwrap_or_default(),
            file,
            reply: reply_from(extra.get("replyTo")),
            delivery,
            read_at,
            transport: if transport == "relay" {
                TransportKind::Relay
            } else {
                TransportKind::P2p
            },
            deleted: extra
                .get("deleted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            reactions: reactions_from(extra.get("reactions")),
            pending,
        });
    }
    Ok(bundle)
}

fn outbox_pending(conn: &Connection) -> std::collections::HashMap<String, Vec<(String, u32)>> {
    let mut out: std::collections::HashMap<String, Vec<(String, u32)>> = Default::default();
    let Ok(mut stmt) = conn.prepare("SELECT message_id, recipient_id, attempt_count FROM outbox")
    else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    }) else {
        return out;
    };
    for (id, to, attempts) in rows.filter_map(Result::ok) {
        out.entry(id)
            .or_default()
            .push((to, u32::try_from(attempts).unwrap_or(0)));
    }
    out
}
