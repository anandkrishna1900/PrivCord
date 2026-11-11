# TURN relay for PrivCord

Two devices usually connect directly. Some networks (many mobile carriers, office and school Wi-Fi, two strict home
routers) make that impossible; then a TURN server forwards the packets. They are already end-to-end encrypted (DTLS),
so the server sees IP addresses and amounts of traffic, never chats. The apps still prefer a direct path whenever one
works; TURN is only the last resort.

## Run it

On any small VPS with a public IP (about 1 GB RAM is plenty):

1. Copy this folder to the server. In `turnserver.conf`, set `external-ip` to the server's public IP and the password
   in `user=privcord:...` to a long random value (`openssl rand -hex 24`).
2. `docker compose up -d`
3. Open UDP and TCP 3478 and UDP 49152-49252 in the server's firewall.

## Use it

Either way below works; you can do both.

**Built into the apps (everyone gets it, nothing to paste).** In the GitHub repository, add three secrets. CI then bakes
the server into the Android APKs and the Windows app:

| Secret | Value |
|---|---|
| `PRIVCORD_TURN_URLS` | `turn:YOUR_HOST:3478,turn:YOUR_HOST:3478?transport=tcp` |
| `PRIVCORD_TURN_USERNAME` | `privcord` |
| `PRIVCORD_TURN_CREDENTIAL` | the password from `turnserver.conf` |

People can switch it off in Settings > Connection ("PrivCord relay when a direct link fails").

**Shared by hand.** `node make-share-line.mjs YOUR_HOST PASSWORD` prints a `PRIVCORD-TURN1:` line to paste into
Settings > Connection on each device.

## What it costs and limits

The server only carries traffic for pairs that cannot connect directly. Each user is capped at 12 relayed connections
and 1.5 Mbit/s, the whole server at 300 connections and 50 Mbit/s (`turnserver.conf`). Relaying to private and loopback
addresses is refused, so the server cannot be used to reach its own network. A password built into the apps can be
extracted by anyone who has the app; if your server gets used by strangers, change the password and rebuild.
