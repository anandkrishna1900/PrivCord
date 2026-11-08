//! The Android app's Room database (version 7, `DuoDatabase.kt`): `messages`, `outbox`, `contacts`, `kv` and
//! `group_logs`. Every private value is `enc1.<iv>.<ciphertext>` under an AES key that lives in the Android Keystore
//! and can never be read out, so the caller supplies a [`Decryptor`] that asks the Keystore.

use crate::{
    desktop::columns, file_meta_from, parse_delivery, parse_trust, reactions_from, reply_from,
    Decryptor, LegacyBundle, LegacyContact, LegacyMessage, ReadError,
};
use privcord_domain::message::TransportKind;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

fn jwk(x: &str, y: &str) -> Value {
    json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y })
}

pub fn read_bundle(db_path: &Path, dec: &dyn Decryptor) -> Result<LegacyBundle, ReadError> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| ReadError::Database)?;
    let msg_cols = columns(&conn, "messages")?;
    if msg_cols.is_empty() {
        return Err(ReadError::NotPrivcord);
    }
    let mut bundle = LegacyBundle::default();

    // Small encrypted values: joined channels (the muted list is also kept on each contact row's flag).
    let kv = |key: &str| -> Option<Value> {
        let raw: String = conn
            .query_row("SELECT valueCipher FROM kv WHERE `key` = ?1", [key], |r| {
                r.get(0)
            })
            .ok()?;
        serde_json::from_str(&dec.text(&raw)?).ok()
    };
    if let Some(Value::Array(names)) = kv("channels") {
        bundle
            .channels
            .extend(names.iter().filter_map(|n| n.as_str().map(str::to_owned)));
    }
    let mut muted: Vec<String> = Vec::new();
    if let Some(Value::Array(list)) = kv("muted") {
        muted.extend(list.iter().filter_map(|n| n.as_str().map(str::to_owned)));
    }

    bundle.muted = muted.clone();

    // Contacts: the card is rebuilt from the stored keys and proof, then verified on import.
    if !columns(&conn, "contacts")?.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT uid, name, signPubX, signPubY, dhPubX, dhPubY, identityProof, isBlocked, verifiedAt, \
                 createdAt, trust, introducedBy, cardName FROM contacts",
            )
            .map_err(|_| ReadError::Database)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, bool>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<String>>(12)?,
                ))
            })
            .map_err(|_| ReadError::Database)?;
        for (
            uid,
            name,
            sx,
            sy,
            dx,
            dy,
            proof,
            blocked,
            verified_at,
            created,
            trust,
            by,
            card_name,
        ) in rows.filter_map(Result::ok)
        {
            let mut card =
                json!({ "v": 1, "sign": jwk(&sx, &sy), "dh": jwk(&dx, &dy), "proof": proof });
            if let (Some(n), Some(o)) = (
                card_name.as_ref().filter(|n| !n.is_empty()),
                card.as_object_mut(),
            ) {
                o.insert("name".into(), json!(n));
            }
            let nickname = Some(name).filter(|n| !n.is_empty() && Some(n) != card_name.as_ref());
            if blocked && !bundle.muted.contains(&uid) {
                bundle.muted.push(uid.clone());
            }
            bundle.contacts.push(LegacyContact {
                muted: blocked || muted.contains(&uid),
                uid,
                card,
                nickname,
                trust: parse_trust(&trust),
                checked: verified_at.is_some(),
                introduced_by: by,
                created_at: created,
            });
        }
    }

    // Groups: each log is saved whole as encrypted JSON.
    if !columns(&conn, "group_logs")?.is_empty() {
        let mut stmt = conn
            .prepare("SELECT groupId, eventsCipher FROM group_logs")
            .map_err(|_| ReadError::Database)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| ReadError::Database)?;
        for (id, cipher) in rows.filter_map(Result::ok) {
            if let Some(Value::Array(events)) = dec
                .text(&cipher)
                .and_then(|t| serde_json::from_str(&t).ok())
            {
                bundle.groups.insert(id, events);
            }
        }
    }

    // Who each unsent message still has to reach.
    let mut pending: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    if !columns(&conn, "outbox")?.is_empty() {
        let mut stmt = conn
            .prepare("SELECT messageId, recipientId, attemptCount FROM outbox")
            .map_err(|_| ReadError::Database)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|_| ReadError::Database)?;
        for (id, to, attempts) in rows.filter_map(Result::ok) {
            pending
                .entry(id)
                .or_default()
                .push((to, u32::try_from(attempts).unwrap_or(0)));
        }
    }

    let extra_col = if msg_cols.contains("extraCipher") {
        "extraCipher"
    } else {
        "NULL AS extraCipher"
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT messageId, clientMessageId, senderId, textCipher, clientCreatedAt, transport, deliveryState, \
             readAt, conversationId, {extra_col} FROM messages"
        ))
        .map_err(|_| ReadError::Database)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })
        .map_err(|_| ReadError::Database)?;
    for (
        id,
        client_id,
        sender,
        text_cipher,
        created_at,
        transport,
        delivery,
        read_at,
        conversation,
        extra_cipher,
    ) in rows.filter_map(Result::ok)
    {
        let Some(text) = dec.text(&text_cipher) else {
            continue;
        };
        let extra: Value = extra_cipher
            .as_deref()
            .and_then(|c| dec.text(c))
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let Some(delivery) = parse_delivery(&delivery) else {
            continue;
        };
        bundle.messages.push(LegacyMessage {
            file: file_meta_from(extra.get("file")),
            reply: reply_from(extra.get("replyTo")),
            pending: pending.remove(&id).unwrap_or_default(),
            id,
            client_id,
            sender,
            text,
            created_at,
            conversation,
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
        });
    }
    Ok(bundle)
}
