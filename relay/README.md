# DuoChat relay

A tiny self-hosted WebSocket server that DuoChat apps use as a **signaling mailbox**
and, optionally, a **store-and-forward queue**. Wire protocol: `docs/CONNECTIVITY.md`
section 5a. It is one of several interchangeable signaling options (the others are
Nostr relays and manual codes); DuoChat does not require it.

What it is not: it is not STUN, not TURN, and it never carries chat traffic of a live
connection. It holds opaque, end-to-end sealed blobs addressed to a mailbox hash.

## Run it

```bash
cd relay
npm ci
PORT=8787 node index.js
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `ALLOW_STORE_FORWARD` | `false` | `true` accepts `kind:"msg"` blobs (up to 7 days, persisted). When `false`, `msg` puts get `err` and nothing is written to disk |
| `DATA_DIR` | `./data` | Where `queue.jsonl` lives (only used when store-and-forward is on) |
| `RATE_LIMIT` | `120` | Frames per minute per client IP |

Limits: blob <= 64 KiB, `sig` ttl <= 120 s (delivered live to current subscribers,
never stored), `msg` ttl <= 7 days, <= 500 queued messages per mailbox.
`GET /healthz` returns counters only. `SIGTERM`/`SIGINT` shut down cleanly.

Then put `wss://your-host` into DuoChat Settings -> Signaling -> Relay.

### Docker

```bash
cd relay
docker build -t duochat-relay .
docker run -d --name duochat-relay -p 8787:8787 \
  -e ALLOW_STORE_FORWARD=true -v duochat-relay-data:/data duochat-relay
```

### VPS / systemd

```ini
# /etc/systemd/system/duochat-relay.service
[Service]
WorkingDirectory=/opt/duochat/relay
ExecStart=/usr/bin/node index.js
Environment=PORT=8787 ALLOW_STORE_FORWARD=true DATA_DIR=/var/lib/duochat-relay
User=duochat
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

Fly.io and similar: run the Docker image, expose port 8787, attach a volume at `/data`
if you enable store-and-forward. (Deployment notes only; not tested on any platform.)

### TLS

The server speaks plain `ws://`. Put a reverse proxy in front for `wss://`
(Caddy: `your-host { reverse_proxy localhost:8787 }`; nginx needs the usual
`Upgrade`/`Connection` headers). Browsers and mobile apps need `wss://`.

## Privacy

The relay can see: mailbox hashes (`sha256("duochat-mailbox-v1|" + uid)`), blob sizes,
timing, and the connecting IP (held in memory only for rate limiting). It cannot read
blobs: they are sealed to the recipient and signed by the sender. It logs counters
only, never blob contents or IPs. With store-and-forward on, sealed blobs are written
to `DATA_DIR/queue.jsonl` until deleted or expired. Whoever runs the relay can still
observe who talks to which mailbox and when.

## Tests

```bash
npm test   # node:test, no extra dependencies
```
