//! Public channel names (`mesh/channel.ts`): `#General`, `general` and `"General  "` are one room.

use crate::limits::MAX_CHANNEL_NAME;
use unicode_normalization::UnicodeNormalization;

/// The normalised room name, or `None` if nothing usable is left.
///
/// NFKC, lower case, one leading `#` run removed, every run of non-letter/non-digit characters becomes one `-`,
/// dashes trimmed from both ends, cut to 32 UTF-16 units, trailing dashes trimmed again.
pub fn normalize_channel_name(raw: &str) -> Option<String> {
    let lowered: String = raw.nfkc().collect::<String>().to_lowercase();
    let without_hash = lowered.trim_start_matches('#');
    let mut dashed = String::with_capacity(without_hash.len());
    let mut in_run = false;
    for c in without_hash.chars() {
        if c.is_alphanumeric() {
            dashed.push(c);
            in_run = false;
        } else if !in_run {
            dashed.push('-');
            in_run = true;
        }
    }
    let trimmed = dashed.trim_matches('-');
    // JavaScript slices by UTF-16 unit; keep whole characters that fit.
    let mut units = 0usize;
    let mut cut = String::new();
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > MAX_CHANNEL_NAME {
            break;
        }
        cut.push(c);
    }
    let name = cut.trim_end_matches('-');
    (!name.is_empty()).then(|| name.to_owned())
}
