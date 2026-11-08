//! The PrivCord application engine.
//!
//! One implementation of the product's rules for Android, Windows, Linux and macOS. A UI sends typed commands and
//! listens to typed events; platform adapters implement the port traits (storage, secure storage, transport, clock,
//! notifications). The engine owns its runtime and tasks, and stops them deterministically on shutdown.

pub mod api;
pub mod core;
pub mod error;
pub mod events;
pub mod runtime;

pub use api::{
    AnswerStatus, AnswerView, ContactView, EngineEvent, GroupView, InviteView, RequestView,
    Snapshot,
};
pub use core::InvitePreview;
pub use core::{Core, LinkSecurity, Ports};
pub use error::ErrorCode;
pub use events::EventStream;
pub use runtime::{Answer, ChannelOp, EngineHandle, FileTarget, GroupOp, Op};
