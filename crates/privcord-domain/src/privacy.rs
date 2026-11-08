//! Who may start a direct chat with whom (`privacy.ts`).
//!
//! People you only know through a group are "introduced". If either side stays group-only, they cannot start a
//! direct chat unless they have swapped invites themselves ("verified").

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContactTrust {
    Verified,
    Introduced,
}

/// May we start a direct chat with this contact? `peer_group_only` is `None` while we do not know their choice yet.
pub fn can_start_direct(
    trust: ContactTrust,
    my_group_only: bool,
    peer_group_only: Option<bool>,
) -> bool {
    trust == ContactTrust::Verified || (!my_group_only && peer_group_only != Some(true))
}

/// May we accept a direct chat they start?
pub fn accepts_direct(trust: ContactTrust, my_group_only: bool) -> bool {
    trust == ContactTrust::Verified || !my_group_only
}
