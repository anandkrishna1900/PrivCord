//! base64url without padding, decoded exactly as the TypeScript `fromB64Url` does (including what it tolerates).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `None` for a character outside the alphabet (padding included) or a dangling non-zero 6-bit remainder. Like the
/// TypeScript decoder it ignores non-zero spare bits in the last character.
pub fn decode(value: &str) -> Option<Vec<u8>> {
    let mut remainder: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    for ch in value.chars() {
        let idx = u32::try_from(ALPHABET.iter().position(|&a| char::from(a) == ch)?).ok()?;
        remainder = (remainder << 6) | idx;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((remainder >> bits) & 0xff).ok()?);
            remainder &= (1 << bits) - 1;
        }
    }
    if bits >= 6 && remainder != 0 {
        return None;
    }
    Some(out)
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.extend(char::from_digit(u32::from(b >> 4), 16));
        s.extend(char::from_digit(u32::from(b & 0x0f), 16));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_length() {
        for n in 0..70usize {
            let data: Vec<u8> = (0..n)
                .map(|i| u8::try_from(i * 7 % 256).unwrap_or(0))
                .collect();
            assert_eq!(decode(&encode(&data)).as_deref(), Some(data.as_slice()));
        }
    }

    #[test]
    fn rejects_padding_and_foreign_characters() {
        assert_eq!(decode("AA=="), None);
        assert_eq!(decode("a+b"), None);
        assert_eq!(decode("é"), None);
    }

    #[test]
    fn tolerates_spare_bits_like_typescript() {
        // "AB" is non-canonical (the second character has spare bits) and TypeScript accepts it.
        assert_eq!(decode("AB"), Some(vec![0]));
        // One dangling character that is zero is accepted as empty, a non-zero one is not.
        assert_eq!(decode("A"), Some(vec![]));
        assert_eq!(decode("B"), None);
    }

    #[test]
    fn matches_the_known_vector() {
        assert_eq!(encode(&[0xfb, 0xff, 0xfe]), "-__-");
    }
}
