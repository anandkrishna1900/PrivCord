//! Canonical JSON (`canonicalJson` in `e2ee/primitives.ts`): object keys sorted by UTF-16 code units, no spaces.
//! It is what gets signed and hashed, so every platform must produce the same bytes.

use crate::error::CryptoError;
use privcord_domain::text::cmp_utf16;
use serde_json::Value;

/// Integers, strings, booleans, null, arrays and objects. A fractional number is refused: nothing signed or hashed
/// contains one, and JavaScript's number formatting is not reproduced here.
pub fn canonical_json(value: &Value) -> Result<String, CryptoError> {
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}

fn write(value: &Value, out: &mut String) -> Result<(), CryptoError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                out.push_str(&n.to_string());
            } else {
                return Err(CryptoError::Canonical);
            }
        }
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).map_err(|_| CryptoError::Canonical)?)
        }
        Value::Array(a) => {
            out.push('[');
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(v, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut entries: Vec<(&String, &Value)> = o.iter().collect();
            entries.sort_by(|a, b| cmp_utf16(a.0, b.0));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).map_err(|_| CryptoError::Canonical)?);
                out.push(':');
                write(v, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}
