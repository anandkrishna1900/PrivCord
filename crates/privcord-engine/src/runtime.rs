//! The asynchronous shell around [`Core`].
//!
//! The engine owns exactly one thread with a current-thread Tokio runtime for its whole life (never one per call).
//! Commands arrive on a bounded queue and are handled one at a time, so there is no shared mutable state and no lock
//! around the engine. A timer drives retries. `shutdown` stops accepting commands, ends every session, joins the thread
//! and reports whether it ended cleanly.

use crate::{
    api::Snapshot,
    core::{Core, LinkSecurity, Ports},
    error::ErrorCode,
    events::EventStream,
};
use privcord_domain::{privacy::ContactTrust, state::ConnectionPath, MessageId, UserId};
use std::{sync::Mutex, thread::JoinHandle, time::Duration};
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

/// Commands waiting for the engine. A full queue rejects with [`ErrorCode::Busy`] instead of growing without bound.
pub const COMMAND_QUEUE: usize = 256;
const TICK: Duration = Duration::from_secs(1);

type Reply<T> = oneshot::Sender<Result<T, ErrorCode>>;

enum Command {
    CreateIdentity(Reply<Zeroizing<String>>),
    RecoverIdentity {
        phrase: Zeroizing<String>,
        passphrase: Zeroizing<String>,
        reply: Reply<()>,
    },
    OwnCard {
        name: Option<String>,
        reply: Reply<String>,
    },
    AddContact {
        card: String,
        trust: ContactTrust,
        reply: Reply<UserId>,
    },
    SetChecked {
        uid: UserId,
        checked: bool,
        reply: Reply<()>,
    },
    SetGroupOnly {
        value: bool,
        reply: Reply<()>,
    },
    SendMessage {
        peer: UserId,
        text: String,
        reply_to: Option<MessageId>,
        reply: Reply<MessageId>,
    },
    MarkRead {
        peer: UserId,
        reply: Reply<()>,
    },
    LinkUp {
        peer: UserId,
        path: ConnectionPath,
        security: LinkSecurity,
        reply: Reply<()>,
    },
    LinkDown {
        peer: UserId,
    },
    Frame {
        peer: UserId,
        text: String,
    },
    Snapshot(Reply<Snapshot>),
    Shutdown(oneshot::Sender<()>),
}

/// A handle to a running engine. Cheap to share by reference; dropping it shuts the engine down.
#[derive(Debug)]
pub struct EngineHandle {
    tx: mpsc::Sender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn pump(core: &mut Core, cmd: Command) -> bool {
    match cmd {
        Command::CreateIdentity(r) => drop(r.send(core.create_identity())),
        Command::RecoverIdentity {
            phrase,
            passphrase,
            reply,
        } => drop(reply.send(core.recover_identity(&phrase, &passphrase))),
        Command::OwnCard { name, reply } => drop(reply.send(core.own_card(name.as_deref()))),
        Command::AddContact { card, trust, reply } => {
            drop(reply.send(core.add_contact(&card, trust)))
        }
        Command::SetChecked {
            uid,
            checked,
            reply,
        } => drop(reply.send(core.set_checked(&uid, checked))),
        Command::SetGroupOnly { value, reply } => drop(reply.send(core.set_group_only(value))),
        Command::SendMessage {
            peer,
            text,
            reply_to,
            reply,
        } => drop(reply.send(core.send_message(&peer, &text, reply_to.as_ref()))),
        Command::MarkRead { peer, reply } => drop(reply.send(core.mark_read(&peer))),
        Command::LinkUp {
            peer,
            path,
            security,
            reply,
        } => drop(reply.send(core.link_up_with(&peer, path, security))),
        Command::LinkDown { peer } => core.link_down(&peer),
        Command::Frame { peer, text } => core.frame_received(&peer, &text),
        Command::Snapshot(r) => drop(r.send(Ok(core.snapshot()))),
        Command::Shutdown(done) => {
            core.shutdown();
            let _ = done.send(());
            return false;
        }
    }
    true
}

impl EngineHandle {
    /// Start an engine. Loads persisted state first, so a failure to read storage is reported here.
    pub fn start(ports: Ports) -> Result<(Self, EventStream), ErrorCode> {
        Self::start_with_context(ports, "duo")
    }

    /// Start with the conversation context the legacy handshake uses (the apps' `conversationId` setting).
    pub fn start_with_context(
        ports: Ports,
        context: &str,
    ) -> Result<(Self, EventStream), ErrorCode> {
        let mut core = Core::new_with_context(ports, context)?;
        let events = core.subscribe();
        let (tx, mut rx) = mpsc::channel::<Command>(COMMAND_QUEUE);
        let thread = std::thread::Builder::new()
            .name("privcord-engine".into())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    let mut timer = tokio::time::interval(TICK);
                    loop {
                        tokio::select! {
                            cmd = rx.recv() => match cmd {
                                Some(cmd) => { if !pump(&mut core, cmd) { break; } }
                                None => { core.shutdown(); break; }
                            },
                            _ = timer.tick() => core.tick(),
                        }
                    }
                });
            })
            .map_err(|_| ErrorCode::Busy)?;
        Ok((
            Self {
                tx,
                thread: Mutex::new(Some(thread)),
            },
            events,
        ))
    }

    async fn ask<T>(&self, build: impl FnOnce(Reply<T>) -> Command) -> Result<T, ErrorCode> {
        let (r, rx) = oneshot::channel();
        self.tx.try_send(build(r)).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => ErrorCode::Busy,
            mpsc::error::TrySendError::Closed(_) => ErrorCode::ShuttingDown,
        })?;
        rx.await.map_err(|_| ErrorCode::ShuttingDown)?
    }

    pub async fn create_identity(&self) -> Result<Zeroizing<String>, ErrorCode> {
        self.ask(Command::CreateIdentity).await
    }
    pub async fn recover_identity(&self, phrase: &str, passphrase: &str) -> Result<(), ErrorCode> {
        self.ask(|reply| Command::RecoverIdentity {
            phrase: Zeroizing::new(phrase.to_owned()),
            passphrase: Zeroizing::new(passphrase.to_owned()),
            reply,
        })
        .await
    }
    pub async fn own_card(&self, name: Option<&str>) -> Result<String, ErrorCode> {
        self.ask(|reply| Command::OwnCard {
            name: name.map(str::to_owned),
            reply,
        })
        .await
    }
    pub async fn add_contact(&self, card: &str, trust: ContactTrust) -> Result<UserId, ErrorCode> {
        self.ask(|reply| Command::AddContact {
            card: card.to_owned(),
            trust,
            reply,
        })
        .await
    }
    pub async fn set_checked(&self, uid: &UserId, checked: bool) -> Result<(), ErrorCode> {
        self.ask(|reply| Command::SetChecked {
            uid: uid.clone(),
            checked,
            reply,
        })
        .await
    }
    pub async fn set_group_only(&self, value: bool) -> Result<(), ErrorCode> {
        self.ask(|reply| Command::SetGroupOnly { value, reply })
            .await
    }
    pub async fn send_message(
        &self,
        peer: &UserId,
        text: &str,
        reply_to: Option<&MessageId>,
    ) -> Result<MessageId, ErrorCode> {
        self.ask(|reply| Command::SendMessage {
            peer: peer.clone(),
            text: text.to_owned(),
            reply_to: reply_to.cloned(),
            reply,
        })
        .await
    }
    pub async fn mark_read(&self, peer: &UserId) -> Result<(), ErrorCode> {
        self.ask(|reply| Command::MarkRead {
            peer: peer.clone(),
            reply,
        })
        .await
    }
    pub async fn snapshot(&self) -> Result<Snapshot, ErrorCode> {
        self.ask(Command::Snapshot).await
    }

    /// An adapter reports that a link to a contact is up and that the engine must encrypt the frames itself.
    pub async fn link_up(&self, peer: &UserId, path: ConnectionPath) -> Result<(), ErrorCode> {
        self.link_up_with(peer, path, LinkSecurity::EngineEncrypted)
            .await
    }

    /// An adapter reports that a link to a contact is up, and says how it is protected.
    pub async fn link_up_with(
        &self,
        peer: &UserId,
        path: ConnectionPath,
        security: LinkSecurity,
    ) -> Result<(), ErrorCode> {
        self.ask(|reply| Command::LinkUp {
            peer: peer.clone(),
            path,
            security,
            reply,
        })
        .await
    }
    /// An adapter reports that the link went away. Fire and forget; the queue is bounded, so a full queue is reported.
    pub fn link_down(&self, peer: &UserId) -> Result<(), ErrorCode> {
        self.push(Command::LinkDown { peer: peer.clone() })
    }
    /// An adapter hands over a frame it received.
    pub fn frame_received(&self, peer: &UserId, text: String) -> Result<(), ErrorCode> {
        self.push(Command::Frame {
            peer: peer.clone(),
            text,
        })
    }

    fn push(&self, cmd: Command) -> Result<(), ErrorCode> {
        self.tx.try_send(cmd).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => ErrorCode::Busy,
            mpsc::error::TrySendError::Closed(_) => ErrorCode::ShuttingDown,
        })
    }

    /// Stop accepting commands, end every session, join the engine thread. Safe to call twice.
    pub async fn shutdown(&self) -> Result<(), ErrorCode> {
        let (done, rx) = oneshot::channel();
        if self.tx.send(Command::Shutdown(done)).await.is_ok() {
            let _ = rx.await;
        }
        self.join()
    }

    fn join(&self) -> Result<(), ErrorCode> {
        let handle = self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        match handle {
            Some(h) => h.join().map_err(|_| ErrorCode::ShuttingDown),
            None => Ok(()),
        }
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        let (done, _rx) = oneshot::channel();
        // Only wait for the thread if it was told to stop. If the queue is full the thread still ends on its own as soon
        // as the sender below is dropped, and waiting here would risk a deadlock.
        if self.tx.try_send(Command::Shutdown(done)).is_ok() {
            let _ = self.join();
        }
    }
}
