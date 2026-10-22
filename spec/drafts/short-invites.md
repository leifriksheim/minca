# Draft: short invites, and finding a space with nobody else online

Status: design, October 2026, revised after one adversarial review (below).
Not normative. Fixes the first half of
[#220](https://github.com/leifriksheim/minca/issues/220) and makes invite links
short enough to paste, say and print.

## The problem

Two things go wrong today, and they share a cause.

1. **Links are long.** An invite carries the whole constitution, the space
   key, the invite secret, the relays and the inviter's DID
   ([03](../03-spaces.md) §7.4). The smallest private space gives an 803
   character link; a space with roles passes 1,500. Chat apps fold it, SMS
   splits it, and a QR code of it is dense.
2. **A joiner can't find a host.** A host is dialled at its `/peer` address
   ([04](../04-network.md) §5.2), never met in a relay room. A device learns
   the address from the space's records, which it doesn't have yet. With only
   the host online, the joiner waits in an empty room
   ([08](../08-hosting.md) §4, Planned).

Putting host addresses in the link fixes 2 and makes 1 worse. The cause of
both is that the link is the only thing the joiner gets.

## What must hold

- **No server required.** Relays and hosts help; nothing needs them. Two
  people on one network, or one QR code, still work.
- **Pluggable.** Where things are kept and where peers meet are places named
  by URL, and a new kind (Nostr, a torrent tracker) is a new plugin, not a new
  invite format.
- **Nothing new to trust.** A relay or host that holds part of an invite
  learns little more than it does today, and can't change what the joiner
  gets.
- **A link is fixed when it is made.** Whoever holds it can read it, and can
  add to where it is kept, but nobody can change or remove it, the inviter
  included. A key change ends it, as it ends a long link today.
- **Simple.** One secret and one pin in the link. Everything else is derived
  from them or checked against the space's own history.

## The design

**The link carries a key and a pin. The key names a mailbox and opens what
is in it. The pin says which space it must be.**

```
https://minca.social/j#ohIu8keaS7VhX3p8HTc70P8q9ohX-_2RrbU1UUUVESo@relay.minca.social
                       └ secret (16 B) ┘└─ pin (16 B) ─┘           └ where it is kept ┘
```

The fragment is 43 characters, plus one or two places. About 85 in all,
against 800 to 1,500 today.

### 1. The link

The link's 32 bytes are `S ‖ pin`:

- `S`, 16 random bytes (128 bits). The mailbox's topic and blob are public to
  whoever asks, so `S` must resist offline guessing; 2¹²⁸ does, and nothing
  shorter leaves a margin against guessing many links at once.
- `pin`, the first 16 bytes of the space id's hash (03 §1.2). A constitution
  that doesn't hash to it is refused. Finding another constitution with the
  same first 128 bits is a second preimage of SHA-256 truncated to 128 bits,
  out of reach.

Everything else comes from `S`, each with its own label:

```
invite secret = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|secret", L = 32)
seal key      = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|seal",   L = 32)
lookup        = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|topic",  L = 32)
topic         = base64url(SHA-256(UTF-8("minca/invite-topic/v1|" + base64url(lookup))))   — 43 characters
```

- The **invite secret** is today's 32-byte secret. The `sys.invite` record,
  joining and closing (03 §7.1–7.3) don't change.
- A view-only link has an `S` too, used only for the seal key and the topic.
- The **topic** is a relay mailbox topic (07 §5), but not a door's: no key
  hashes to it, so the relay's purge check (07 §4–5) never passes and **no
  one can clear it**. It comes from neither the invite key nor anything in
  the space, so a peer that holds the space's records can't compute it.

### 2. The sealed invite

What was the whole link is now the plaintext of a blob in the mailbox:

```json
{
  "v": 1,
  "invite": { "space": { … }, "key": "…", "role": "member", "relays": ["wss://relay.minca.social"] },
  "nodes": ["wss://host.example/peer#did:key:zDnae…"]
}
```

```
blob = base64url( nonce(12) ‖ AES-256-GCM(seal key, nonce, deflate-raw(UTF-8(JSON)), aad = UTF-8(topic)) )
```

- `invite` is today's `SpaceInvite` (03 §7.4) without `invite` (the secret is
  in the link) and without `invitedBy` (unauthenticated, and the space's
  history says who opened the invite).
- `key` is the space key **when the link was made**. A blob is never sealed
  again: not for a key change, not for new relays or hosts.
- `nodes` are always-on nodes that hold the space, pinned by DID (04 §5.2).
  This is what fixes #220.
- Compressed with `CompressionStream("deflate-raw")`, a web standard in
  browsers, Node and Bun. The sealed blob fits a mailbox blob (12,000
  characters, 07 §5); a reader refuses one that inflates past 64 KiB.

No signature. Any holder of `S` can make a blob that opens, so the joiner
trusts no single blob: the pin fixes the space, and the rest are hints it
takes together (§4).

### 3. Where it is kept

The inviter drops the blob in the mailboxes of the space's relays
(`sys.relays`) and its own. The link names one or two of them after `@`, as
`host[:port][/path]`, read as `wss://` (as `ws://` for `localhost`,
`127.0.0.1` and `[::1]`, so a hint never sends a joiner to plain `ws://`
elsewhere). A joiner asks the named mailboxes and its own relays.

A relay keeps a blob up to 14 days (07 §5) and may forget it on a restart.
Two things keep it longer, and neither holds `S`:

- **The account.** The inviter's device writes `{ topic, blob, mailboxes,
until }` in the account registry (03 §13). Any of the account's devices
  that is online drops the same blob again when it is gone from a mailbox.
  Dropping a blob a relay already holds stores nothing new (07 §5), so this
  costs nothing while it is there. An app holding the account sees a topic
  and ciphertext, as a relay does.
- **The host.** Each device keeps these records in step with the carry spaces
  of the account's carriers (06 §4.2), as it does passes. A host's mailbox
  answers a fetch of that topic with the blob, from the record, for as long
  as the record is there and `until` has not passed. It drops nothing
  anywhere, so the record can't point the host at another server. A host
  keeps at most 64 such records an account.

The device that made the link keeps `S` under its local key (05 §15), so
the person can copy the link again. That is a library convenience; `S` is
never written to the registry or any space.

Closing a link is closing its invite in the space (03 §7.2), which every peer
judges. The account deletes the registry record, so its devices and host stop
serving the blob, and relays forget it within 14 days. Anyone who fetched it
can drop it again; that gives nothing a closed invite doesn't already give.

### 4. Joining

1. Read `S`, `pin` and the places from the link.
2. Fetch the topic from each place at once. Open every blob, and keep those
   that open, inflate within the limit, and whose constitution hashes to an id
   starting with `pin`.
3. Check each as an invite is checked today (03 §7.6).
4. Take them together, not the newest:
   - the constitution is the same in all of them (the pin);
   - every `key` is imported. A key's id is its hash, so it is a key the
     history names or one that opens nothing (03 §7.6);
   - `relays` and `nodes` are hints, unauthenticated, as `relays` is today;
   - `role` is for display; the invite record decides.
5. Join with the invite secret derived from `S`, and dial the nodes and relays
   at once.

The nodes from the invite are kept with the space as its relays are. Once
the joiner holds the space's access history, it keeps dialling only nodes
whose DID `sys.keepers` names (03 §10). A device holding the account key
names the account's carriers as keepers in every space where it may
(06 §4.2), so the inviter's own host stays; a node someone else put in a
blob goes. A space that names no keepers keeps the invite's nodes until the
device restarts.

Preview is steps 1–4. No blob found means the link has expired or the
places named are gone; the joiner is told that, not that it was closed.

### 5. Still works with no server

The long link stays, as `#invite=` (03 §7.4). Readers accept both forms. An
app makes a long link when it has no mailbox to drop in, or when asked: for
a QR code shown in person, on a network with no relay, or for a space that
must not touch one.

## Where peers meet: pluggable

Section 3 makes the mailbox one kind of place. The design names two kinds,
each by URL, so each gets plugins:

| Kind                                 | Does                                     | Today                     | Could be                                                               |
| ------------------------------------ | ---------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| **Mailbox**                          | Keeps a small sealed blob under a topic  | A relay's mailbox (07 §5) | A Nostr addressable event; a host over HTTPS; BEP 44 DHT               |
| **Meeting place**                    | Finds peers in a room and passes signals | A relay's room (04 §1)    | Nostr ephemeral events; a WebTorrent tracker; mDNS                     |
| **Node** (a place you dial directly) | Takes a connection                       | `wss://…/peer` (04 §5.2)  | WebTransport, with `serverCertificateHashes` so a host needs no domain |

What each plugin must agree on with other implementations is protocol, and
goes in 04 when it is built: for Nostr, the event kinds and tags; for a
tracker, the info hash. A room is already 20 bytes of hash (04 §1.3), the
size of a torrent info hash. What stays the same across all of them: peers
prove who they are and that they may read once connected (04 §6), so a
meeting place is trusted with no more than a relay is. A mailbox is trusted
with even less: it holds what any link holder may add to, and the joiner
takes nothing from it on trust.

This draft builds only the relay mailbox and the node address. The table is
there so the link format doesn't have to change when the others arrive: a
place in the link is a URL, and a plugin claims the schemes it knows.

## What a party learns, and can do

| Party       | Today                                  | With short invites                                                                                                                                     |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link holder | The space, its key, the right to join  | The same. Also: may add blobs. They can't change the space (the pin) or remove the inviter's blob; they can add relays and nodes, which are only hints |
| Relay       | Rooms, peers, door mailboxes           | Also: a topic, a blob's size, when and from which address it is fetched. Not which space, even for a relay that holds it                               |
| Host        | Its spaces, sizes, which account asked | Also: that an account keeps a link, its topic, until when, and who fetches it                                                                          |
| Chat app    | The whole invite, if it reads the URL  | The secret, if it reads the fragment; unfurlers don't                                                                                                  |

What a relay, or a link holder, can do to a link:

- **Withhold it.** The joiner asks every place named and its own relays; the
  host serves it from a record nobody else can touch; the long link is the
  fallback.
- **Flood the topic** at a relay (64 blobs, 07 §5), so a drop after the
  inviter's blob expires is refused. Blobs a relay holds stay until they
  expire, and the host's copy is not in the relay's queue. Takes 16 addresses
  an hour on the reference relay; it joins
  [#162](https://github.com/leifriksheim/minca/issues/162).
- **Add a node it runs.** The joiner dials it and learns nothing it couldn't
  learn by joining; the node can't forge records. It is let go of once the
  history shows the keepers.
- **Add an old key** (a former member's). The joiner imports it; it opens
  only what that member could already read.

## Changes to the spec

- **03 §7**: a new §7.7, the short link (derivations, link format, sealed
  invite, joining). §7.4 says the long form stays; §7.6 that keys from
  several blobs are imported alike.
- **03 §13.2**: the registry record holding a link's blob, and that `S` is
  never kept there ("secrets are never kept" still holds).
- **06 §4.2**: the carry space's copy of that record, and that a host's
  mailbox serves it.
- **07 §5**: the mailbox holds invite topics as well as door topics; a topic
  no key hashes to can't be purged. Nothing a relay does changes.
- **08 §4**: the "Invites that name the space's hosts" Planned text goes.
- **Threat model**: §2 Stranger (a leaked short link lets it add hints);
  §3.1 (the forging claim holds for the space, and says what a link holder may
  add); §3.7 Relay and §3.8 Host gain the rows above.

## Plan

1. `packages/core/src/space/invite-link.ts`: `deriveInviteLink(S)`,
   `encodeInviteLink`, `parseInviteLink`, `sealInvite`, `openInvite`. Tests
   with fixed vectors.
2. `packages/core/src/network/mailbox.ts`: nothing new; reuse `drop` and
   `fetch`.
3. `packages/core/src/node/node.ts`: `spaces.invite` returns the short link
   (`{ long: true }` for the old one); `preview` and `join` accept both;
   `join` takes blobs together and keeps invite nodes as above; the registry
   record, dropping again when gone, deleting it on `closeInvite`; the copy in
   carry spaces.
4. `packages/core/src/node/host.ts`, `packages/cli/src/serve.ts`: the host's
   mailbox answers from carry-space records.
5. Spec and docs as above; `packages/core/docs/spaces.md#invites`.
6. Apps: the shorter link and a QR code.
7. Tests:
   - a joiner with only a host online gets the space (fails today, #220);
   - a link holder's blob for another space is refused by the pin; one with
     other nodes adds only hints, and its node is let go of after sync;
   - nobody can clear the topic (the relay refuses a purge);
   - after a removal and a key change, the link no longer lets anyone read,
     and the removed member gets nothing from the mailbox;
   - with every device offline, the host serves the blob past a relay's TTL,
     and stops once the record is deleted;
   - a blob that inflates past the limit is refused;
   - the long link still joins.
8. A scenario: the chess club posts a role link publicly; a link holder
   tries to redirect it, to clear it, and a removed member tries to keep
   reading.

## Adversarial review

The first review found two blockers. Both came from one assumption: that
holding `S` is no more than joining, so it could also update and clear the
link. It can't.

| Finding                                                                                                   | What changed                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Blocker.** Sealing again after a key change gave a removed member the new key                           | Blobs are never sealed again. A key change ends a link, as today                                                    |
| **Blocker.** Any link holder could clear the topic and replace the invite                                 | The topic is no door's, so nobody can purge it. The pin fixes the space. Blobs are taken together, not newest-first |
| The topic came from `sys.invite.key`, so whoever holds the space could find it                            | The topic comes from `S` alone                                                                                      |
| A carrier's drop instructions could point a host at any server                                            | The host drops nothing; it serves from the record. At most 64 an account                                            |
| Keeping `S` in the registry broke "secrets are never kept" and §3.6                                       | `S` stays on the device that made the link; the registry holds only ciphertext                                      |
| The nodes' stop condition named records a joiner never sees                                               | Kept while `sys.keepers` names them                                                                                 |
| `at` followed device clocks; "not found" claimed "closed"; deflate bombs; door-topic claim; `ws://` hints | `at` gone; wording fixed; a 64 KiB limit; claim gone; hints read as `ws://` only on localhost                       |

## Considered and not chosen

- **Hosts in the link.** Fixes #220, adds about 50 characters per host, and
  goes stale when a host moves.
- **Link = space id + secret, the rest from peers.** About 100 characters and
  no mailbox, but nothing can be previewed and the key has to be boxed to the
  invite key inside the space: a new protocol record.
- **Hosts on the relay mesh.** WebRTC on servers, and the relay's limits
  (256 rooms a socket, 50 messages a second) bite a host with many spaces.
- **Short codes held by one host** (`host/i/x7k2`). Short, but the invite
  lives or dies with that host. The `@` hint gets most of this.
- **Signing the blob with a key only the inviter holds.** Would let the
  inviter update it, but the joiner needs the public key or a hash of it in
  the link, and an update after a key change is exactly the first blocker.
- **Signed contact cards for every keeper.** Useful once nodes move often;
  not needed while links are short-lived and keepers are named in the space.

## Prior art

- **Hypercore's blind pairing** (`holepunchto/blind-pairing-core`) is this
  design's nearest relative: a seed in the invite gives a key pair, and the
  invite id, the encryption key and the nonce are separate hashes of it. Its
  joiner checks that what it got hashes to what the invite committed to, as
  ours checks the constitution against the pin.
- **Signal's group links** carry a 32-byte master key and a 16-byte password
  in the fragment; the group's title and members sit encrypted on Signal's
  server, fetched by the password. The same split: a lookup name and a
  separate key.
- **Magic Wormhole** keeps codes tiny with a PAKE against a party that is
  online. With nobody online, a mailbox needs a secret that resists offline
  guessing, so ours is 128 bits; Trystero, which hashes a password with no
  KDF, shows what happens otherwise.
- **Signed records anyone may carry**: Pkarr (a signed DNS packet on the
  Mainline DHT), IPNS, BEP 44 and libp2p's peer records name a record by its
  key, and carry `seq` and an expiry so any store can hold it. That is the
  shape for contact cards, if they come.
- **Nostr's outbox model** (NIP-65) and Matrix's `via=` hints: the address
  names where to look. The `@` places are the same idea.

Each other network needs its own key: Nostr signs with Schnorr on
secp256k1, BEP 44 and Pkarr with ed25519. A plugin derives its key from `S`
with its own HKDF label, never from the P-256 invite key; `@noble/curves`
already has both.

## Open questions

- **How many places in the link.** One keeps it short; two survives one
  relay going away.
- **A shorter pin.** 12 bytes (96 bits) would save 5 characters and still
  be far out of reach for one space; 16 leaves a margin.
- **QR codes.** Uppercase base32 (52 characters for 32 bytes) fits a QR
  code's alphanumeric mode and makes it much smaller, but `#` and lowercase
  hosts don't. A QR code could carry `MINCA:` and the base32 bytes, and the
  scanning app supply its own places.
- **The app's origin.** The link names an app (`minca.social/j`). Should any
  Minca app open any link, by a registered scheme or a shared path?
- **Rooms on public networks.** On Nostr or the DHT anyone who knows a
  space's id can watch its room. A private space's room there could come from
  its read seed, which changes with its key. Belongs to the Nostr and tracker
  plugins, not this draft.
