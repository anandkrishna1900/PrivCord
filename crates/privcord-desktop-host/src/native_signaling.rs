//! The relay sockets, owned by the desktop shell in Rust instead of by the web page (docs/design/syncengine.md §10).
//!
//! With the sockets here, the window can be closed completely when DuoCord sits in the tray: messages, sync entries
//! and notifications keep arriving with only the Rust engine running. The relay and Nostr protocol logic is the
//! engine's own (`privcord_engine::signaling`), the same the phone uses; this file only carries out what it asks for
//! on real WebSockets: one hub per mailbox, as the page did.
//!
//! In private mode every connection goes through Tor's SOCKS proxy, and host names are resolved by Tor (never here).
//!
//! ponytail: one worker thread, blocking connects with a short timeout; per-connection threads if a slow relay ever
//! holds the others up noticeably.

use privcord_crypto::rng::OsEntropy;
use privcord_domain::{
    blob::SealedBlob,
    network::{NetworkConfig, SignalingConfig},
    signaling::{PutKind, SignalingStatus},
};
use privcord_engine::signaling::{
    hub::{Service, SignalingHub},
    nostr::NostrTransport,
    relay::RelayClient,
    Action, Event, Out, PutRequest,
};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Receiver, Sender},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tungstenite::{client::IntoClientRequest, stream::MaybeTlsStream, Message, WebSocket};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;
/// Called with (mailbox, encoded sealed blob) for every blob that arrives.
pub type BlobSink = Arc<dyn Fn(String, String) + Send + Sync>;
/// Called when the relays as a whole go online or offline.
pub type StatusSink = Arc<dyn Fn(bool) + Send + Sync>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// How long one read waits on an idle socket.
const READ_WAIT: Duration = Duration::from_millis(2);
const TICK_EVERY: Duration = Duration::from_millis(500);
/// A put waits this long for a relay to be online, as the page did.
const PUT_WAIT: Duration = Duration::from_secs(20);
const IDLE_SLEEP: Duration = Duration::from_millis(20);

enum Cmd {
    Configure {
        config: NetworkConfig,
        socks: Option<String>,
    },
    Subscribe(String),
    Unsubscribe(String),
    Put {
        mailbox: String,
        blob: String,
        kind: PutKind,
        ttl_sec: u32,
    },
    Stop,
}

/// The relay sockets of one install, on their own thread.
pub struct NativeSignaling {
    tx: Sender<Cmd>,
    online: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl NativeSignaling {
    pub fn start(sink: BlobSink, status: StatusSink) -> Self {
        let (tx, rx) = channel();
        let online = Arc::new(AtomicBool::new(false));
        let flag = online.clone();
        let worker = std::thread::Builder::new()
            .name("relay-sockets".into())
            .spawn(move || Worker::new(sink, status, flag).run(&rx))
            .ok();
        Self { tx, online, worker }
    }

    /// New network settings (the page's saved JSON) and, in private mode, Tor's SOCKS proxy. Every mailbox's sockets
    /// are opened again with them.
    pub fn configure(&self, network_json: &str, socks: Option<String>) {
        let config = NetworkConfig::parse(Some(network_json));
        let _ = self.tx.send(Cmd::Configure { config, socks });
    }

    pub fn subscribe(&self, mailbox: &str) -> bool {
        self.tx.send(Cmd::Subscribe(mailbox.to_owned())).is_ok()
    }

    pub fn unsubscribe(&self, mailbox: &str) {
        let _ = self.tx.send(Cmd::Unsubscribe(mailbox.to_owned()));
    }

    /// Queues a blob to publish. `false` when no relay is online, so the engine can try another way (mutual contacts).
    pub fn put(&self, mailbox: &str, blob: &str, kind: PutKind, ttl_sec: u32) -> bool {
        self.online()
            && self
                .tx
                .send(Cmd::Put {
                    mailbox: mailbox.to_owned(),
                    blob: blob.to_owned(),
                    kind,
                    ttl_sec,
                })
                .is_ok()
    }

    pub fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
}

impl std::fmt::Debug for NativeSignaling {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeSignaling")
            .field("online", &self.online())
            .finish_non_exhaustive()
    }
}

impl Drop for NativeSignaling {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Stop);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

struct Hub {
    hub: SignalingHub,
    sockets: BTreeMap<String, Ws>,
}

struct PendingPut {
    mailbox: String,
    blob: SealedBlob,
    kind: PutKind,
    ttl_sec: u32,
    until: Instant,
}

struct Worker {
    config: NetworkConfig,
    socks: Option<String>,
    hubs: BTreeMap<String, Hub>,
    puts: Vec<PendingPut>,
    sink: BlobSink,
    status: StatusSink,
    online: Arc<AtomicBool>,
    began: Instant,
    last_tick: Instant,
    put_seq: u64,
}

fn services_for(config: &NetworkConfig, mailbox: &str) -> Vec<Service> {
    config
        .signaling
        .iter()
        .map(|s| match s {
            SignalingConfig::Relay { url } => Service::Relay(RelayClient::new(url)),
            SignalingConfig::Nostr { relays } => Service::Nostr(NostrTransport::new(
                relays,
                &format!("dc-{}", mailbox.get(..12).unwrap_or(mailbox)),
            )),
        })
        .collect()
}

impl Worker {
    fn new(sink: BlobSink, status: StatusSink, online: Arc<AtomicBool>) -> Self {
        Self {
            config: NetworkConfig {
                signaling: Vec::new(),
                ..NetworkConfig::default()
            },
            socks: None,
            hubs: BTreeMap::new(),
            puts: Vec::new(),
            sink,
            status,
            online,
            began: Instant::now(),
            last_tick: Instant::now(),
            put_seq: 0,
        }
    }

    fn now(&self) -> i64 {
        // Wall-clock milliseconds: the Nostr client stamps events with them.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or_else(|_| i64::try_from(self.began.elapsed().as_millis()).unwrap_or(0))
    }

    fn run(mut self, rx: &Receiver<Cmd>) {
        loop {
            let mut busy = false;
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Stop) => {
                        self.stop_all();
                        return;
                    }
                    Ok(cmd) => {
                        busy = true;
                        self.handle(cmd);
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        self.stop_all();
                        return;
                    }
                }
            }
            busy |= self.read_all();
            if self.last_tick.elapsed() >= TICK_EVERY {
                self.last_tick = Instant::now();
                self.tick_all();
            }
            busy |= self.flush_puts();
            self.report();
            if !busy {
                std::thread::sleep(IDLE_SLEEP);
            }
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Configure { config, socks } => {
                self.config = config;
                self.socks = socks;
                let mailboxes: Vec<String> = self.hubs.keys().cloned().collect();
                for m in mailboxes {
                    self.subscribe(&m);
                }
            }
            Cmd::Subscribe(m) => {
                if !self.hubs.contains_key(&m) {
                    self.subscribe(&m);
                }
            }
            Cmd::Unsubscribe(m) => {
                if let Some(mut h) = self.hubs.remove(&m) {
                    let _ = h.hub.stop();
                    for (_, mut s) in std::mem::take(&mut h.sockets) {
                        let _ = s.close(None);
                    }
                }
            }
            Cmd::Put {
                mailbox,
                blob,
                kind,
                ttl_sec,
            } => {
                if let Some(blob) = SealedBlob::decode(&blob) {
                    self.puts.push(PendingPut {
                        mailbox,
                        blob,
                        kind,
                        ttl_sec,
                        until: Instant::now() + PUT_WAIT,
                    });
                }
            }
            Cmd::Stop => {}
        }
    }

    fn subscribe(&mut self, mailbox: &str) {
        if let Some(mut old) = self.hubs.remove(mailbox) {
            for (_, mut s) in std::mem::take(&mut old.sockets) {
                let _ = s.close(None);
            }
        }
        let mut hub = Hub {
            hub: SignalingHub::new(services_for(&self.config, mailbox)),
            sockets: BTreeMap::new(),
        };
        let out = hub.hub.start(mailbox);
        self.hubs.insert(mailbox.to_owned(), hub);
        self.apply(mailbox, out);
    }

    fn stop_all(&mut self) {
        for (_, mut h) in std::mem::take(&mut self.hubs) {
            let _ = h.hub.stop();
            for (_, mut s) in h.sockets {
                let _ = s.close(None);
            }
        }
    }

    /// Carries out what a hub asked for, and passes on what it reported.
    fn apply(&mut self, mailbox: &str, out: Out) {
        let mut pending = vec![out];
        while let Some(out) = pending.pop() {
            for e in out.events {
                if let Event::Blob { blob, .. } = e {
                    (self.sink)(mailbox.to_owned(), blob.encode());
                }
            }
            for a in out.actions {
                let now = self.now();
                let socks = self.socks.clone();
                let Some(h) = self.hubs.get_mut(mailbox) else {
                    return;
                };
                match a {
                    Action::Connect { url } => match connect(&url, socks.as_deref()) {
                        Ok(ws) => {
                            h.sockets.insert(url.clone(), ws);
                            pending.push(h.hub.socket_opened(&url, now));
                        }
                        Err(_) => pending.push(h.hub.socket_closed(&url, now)),
                    },
                    Action::Send { url, text } => {
                        let failed = h
                            .sockets
                            .get_mut(&url)
                            .is_none_or(|s| s.send(Message::text(text)).is_err());
                        if failed {
                            h.sockets.remove(&url);
                            pending.push(h.hub.socket_closed(&url, now));
                        }
                    }
                    Action::Close { url } => {
                        if let Some(mut s) = h.sockets.remove(&url) {
                            let _ = s.close(None);
                        }
                    }
                }
            }
        }
    }

    /// Reads every socket once. Returns whether anything arrived.
    fn read_all(&mut self) -> bool {
        let mut any = false;
        let keys: Vec<(String, String)> = self
            .hubs
            .iter()
            .flat_map(|(m, h)| h.sockets.keys().map(move |u| (m.clone(), u.clone())))
            .collect();
        for (mailbox, url) in keys {
            let now = self.now();
            let Some(h) = self.hubs.get_mut(&mailbox) else {
                continue;
            };
            let Some(sock) = h.sockets.get_mut(&url) else {
                continue;
            };
            let out = match sock.read() {
                Ok(Message::Text(t)) => {
                    any = true;
                    h.hub.socket_message(&url, t.as_str(), now)
                }
                Ok(Message::Close(_)) => {
                    h.sockets.remove(&url);
                    h.hub.socket_closed(&url, now)
                }
                Ok(_) => continue,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(_) => {
                    h.sockets.remove(&url);
                    h.hub.socket_closed(&url, now)
                }
            };
            self.apply(&mailbox, out);
        }
        any
    }

    fn tick_all(&mut self) {
        let mailboxes: Vec<String> = self.hubs.keys().cloned().collect();
        for m in mailboxes {
            let now = self.now();
            let Some(h) = self.hubs.get_mut(&m) else {
                continue;
            };
            let out = h.hub.tick(now);
            self.apply(&m, out);
        }
    }

    /// Sends queued puts through a hub that is online (the mailbox's own, else any). Returns whether one went out.
    fn flush_puts(&mut self) -> bool {
        let mut sent = false;
        let mut keep = Vec::new();
        for p in std::mem::take(&mut self.puts) {
            let hub_key = if self
                .hubs
                .get(&p.mailbox)
                .is_some_and(|h| h.hub.status() == SignalingStatus::Online)
            {
                Some(p.mailbox.clone())
            } else {
                self.hubs
                    .iter()
                    .find(|(_, h)| h.hub.status() == SignalingStatus::Online)
                    .map(|(k, _)| k.clone())
            };
            let Some(key) = hub_key else {
                if Instant::now() < p.until {
                    keep.push(p);
                }
                continue;
            };
            self.put_seq += 1;
            let put_id = format!("n{}", self.put_seq);
            let now = self.now();
            let Some(h) = self.hubs.get_mut(&key) else {
                continue;
            };
            let req = PutRequest {
                mailbox: &p.mailbox,
                blob: &p.blob,
                kind: p.kind,
                ttl_sec: p.ttl_sec,
                put_id: &put_id,
            };
            if let Ok(out) = h.hub.put(req, now, &mut OsEntropy) {
                self.apply(&key, out);
                sent = true;
            }
        }
        self.puts = keep;
        sent
    }

    fn report(&mut self) {
        let online = self
            .hubs
            .values()
            .any(|h| h.hub.status() == SignalingStatus::Online);
        if self.online.swap(online, Ordering::SeqCst) != online {
            (self.status)(online);
        }
    }
}

/// Opens a WebSocket (TLS for `wss://`), through a SOCKS5 proxy when one is given.
fn connect(url: &str, socks: Option<&str>) -> Result<Ws, String> {
    let request = url.into_client_request().map_err(|e| e.to_string())?;
    let uri = request.uri().clone();
    let host = uri
        .host()
        .ok_or("no host")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("wss") {
            443
        } else {
            80
        });
    let tcp = match socks {
        Some(proxy) => socks5(proxy, &host, port)?,
        None => {
            let addr = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| e.to_string())?
                .next()
                .ok_or("no address")?;
            TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?
        }
    };
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    #[cfg(feature = "tls")]
    let (ws, _) = tungstenite::client_tls(request, tcp).map_err(|e| e.to_string())?;
    #[cfg(not(feature = "tls"))]
    let (ws, _) = {
        if uri.scheme_str() == Some("wss") {
            return Err("built without TLS".into());
        }
        tungstenite::client(request, MaybeTlsStream::Plain(tcp)).map_err(|e| e.to_string())?
    };
    // From here on a read only waits a moment, so one quiet relay does not hold up the others.
    let stream = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => Some(s),
        #[cfg(feature = "tls")]
        MaybeTlsStream::NativeTls(s) => Some(s.get_ref()),
        _ => None,
    };
    if let Some(s) = stream {
        s.set_read_timeout(Some(READ_WAIT))
            .map_err(|e| e.to_string())?;
    }
    Ok(ws)
}

/// A minimal SOCKS5 CONNECT (no authentication), with the host name resolved by the proxy (Tor).
fn socks5(proxy: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    let addr = proxy
        .trim_start_matches("socks5h://")
        .trim_start_matches("socks5://");
    let proxy_addr = addr
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("bad proxy")?;
    let mut s =
        TcpStream::connect_timeout(&proxy_addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    s.write_all(&[5, 1, 0]).map_err(|e| e.to_string())?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).map_err(|e| e.to_string())?;
    if reply != [5, 0] {
        return Err("the proxy refused".into());
    }
    let name = host.as_bytes();
    let len = u8::try_from(name.len()).map_err(|_| "host name too long")?;
    let mut req = vec![5, 1, 0, 3, len];
    req.extend_from_slice(name);
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).map_err(|e| e.to_string())?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).map_err(|e| e.to_string())?;
    if head[1] != 0 {
        return Err(format!("the proxy could not connect ({})", head[1]));
    }
    // The bound address that follows, which we do not need.
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).map_err(|e| e.to_string())?;
            usize::from(l[0]) + 2
        }
        _ => return Err("bad proxy reply".into()),
    };
    let mut skip = vec![0u8; rest];
    s.read_exact(&mut skip).map_err(|e| e.to_string())?;
    Ok(s)
}
