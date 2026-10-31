# Open channels and the Bluetooth mesh

## Open channels

A channel is a public room with a name, like `#general` or `#lagos`. There is nothing to create: anyone who types
the same name is in the same room. There is no owner, no member list and no history guarantee.

* **Names** are normalized (`#General`, `general`, ` GENERAL ` are one room; letters and digits in any language).
* **Messages** carry the sender's name and their identity card and are signed with their identity key, so nobody
  can write as somebody else. The app shows `Name #a1b2` (self-chosen name plus the first 4 characters of the
  identity fingerprint) so two people called "Alex" can be told apart.
* **Not private.** Anyone who knows the name can read the room. The name is turned into a relay mailbox (a
  hash) and an AES key, so a relay operator or a passive observer who does not know the name sees only ciphertext.
  A hard-to-guess name works like a shared password for a private-ish room, but a group is the right tool for
  a private conversation.
* **Where it travels:** the internet relays you configured (Nostr or your own), and, on Android with the mesh on,
  Bluetooth hops (below). A live copy is always sent; a stored copy (history for people who join later) is kept on a
  relay only if **store-and-forward** is on. Text only, 500 characters, no files or replies.
* **Abuse:** no moderation exists. You can mute a person (kept on your device), a phone passes on at most 30 new
  messages per minute per sender over the mesh, and you can leave. Nothing stops a determined spammer from creating
  new identities. Keep this in mind before treating a public channel as safe.
* Up to 8 channels at a time on one device (each keeps its own relay connection).

## Bluetooth mesh (Android)

With the mesh on (Settings > Connection), a phone advertises and scans for other phones running the mesh and keeps up
to 5 Bluetooth links to strangers. Messages are passed along:

* **What travels:** only sealed blobs. A direct message is already end-to-end encrypted to its recipient and signed;
  a channel message is signed. A relaying phone needs no keys and cannot change a message (the signature would break).
* **Flooding with a hop limit:** a new message is given to every neighbour except the one it came from. It is passed
  on at most 7 hops. A phone remembers what it has seen, so loops do not repeat messages.
* **Store, carry, forward:** a phone keeps what it relayed for 30 minutes and gives it to neighbours it meets later,
  so messages can cross gaps by people walking around.
* **Direct messages** for a friend you are not connected to also go out over the mesh, and the acknowledgement comes
  back the same way. Channel messages go out over the mesh as well as the relays.
* **Limits:** a message is dropped after 7 hops or 30 minutes; a sender can put 30 new messages per minute into any
  one phone; packets larger than 8 KB are refused. Asynchronous flooding is best-effort: a phone that hears a copy
  over a long path first ignores a better copy that arrives later, so the real reach can be slightly less than 7 hops.

### What the mesh reveals

* Bluetooth advertising announces that a PrivCord phone is nearby (a fixed service id). It is off by default.
* Relaying phones see each blob's sender and recipient labels (`from` / `to`) and timing, but not the text of direct
  messages or the content of channels they have not joined.
* There is no link-layer encryption between strangers (there is nothing to authenticate against); everything that
  matters is protected end to end.

### Status

* The relaying logic (`packages/protocol/src/mesh/node.ts`, `apps/android/.../ble/MeshNode.kt`) is tested in
  simulation: chains, rings with loops, a random 30-phone network, hop limit, carry and expiry, flooding limits.
* The radio (`AndroidMeshRadio.kt`) is **compiled but never run on a real phone**. Expect to find bugs when two
  phones first connect (GATT quirks differ across devices). It only runs if you turn the mesh on.
* Windows cannot take part in the Bluetooth mesh (the desktop app can only scan), so on Windows channels use the
  internet relays only.
