//! Text rules that must behave exactly like the JavaScript the apps were first written in.

/// JavaScript's `String.prototype.trim` whitespace set (not the same as Rust's: it includes U+FEFF and leaves U+0085).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `str.trim()` as JavaScript does it.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// Length in Unicode code points (what `Array.from(text).length` counts).
pub fn count_code_points(s: &str) -> usize {
    s.chars().count()
}

/// `\r\n` and lone `\r` become `\n`.
pub fn normalize_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// The first `n` code points.
pub fn take_code_points(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// UTF-16 length, which is what JavaScript's `.length` reports.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Ordering by UTF-16 code units, which is what JavaScript's `<` uses on strings.
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_javascript() {
        assert_eq!(js_trim("\u{FEFF} hi \u{00A0}"), "hi");
        // U+0085 is whitespace to Rust but not to JavaScript.
        assert_eq!(js_trim("\u{0085}"), "\u{0085}");
        assert_eq!(js_trim(" \n\t "), "");
    }

    #[test]
    fn newlines_normalise() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd\r\n\r"), "a\nb\nc\nd\n\n");
    }

    #[test]
    fn counts_code_points_not_bytes_or_units() {
        assert_eq!(count_code_points("a😀é"), 3);
        assert_eq!(utf16_len("a😀é"), 4);
    }

    #[test]
    fn utf16_order_differs_from_utf8_order_only_for_supplementary_characters() {
        // U+FF5E (BMP) sorts after U+1F600 (supplementary, high surrogate D83D) in UTF-16, before it in UTF-8.
        assert_eq!(
            cmp_utf16("\u{FF5E}", "\u{1F600}"),
            std::cmp::Ordering::Greater
        );
        assert_eq!("\u{FF5E}".cmp("\u{1F600}"), std::cmp::Ordering::Less);
    }
}
