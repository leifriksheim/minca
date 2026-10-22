# Draft: short invites, and finding a space with nobody else online

Status: design, October 2026. Not normative. Fixes the first half of
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
  learns no more than it does today, and can't change what the joiner gets.
- **Simple.** One secret in the link. Everything else is derived from it or
  checked against the space's own history.

## The design

**The link carries a key. The key names a mailbox. The mailbox holds the
invite, sealed.**

```
https://minca.social/j#k7Qw2mZ9xP4vL8nR3tY6bA@relay.minca.social
                       └──── 16-byte secret ───┘ └── where it is kept ─┘
```

### 1. The link secret

`S` is 16 random bytes (128 bits). Everything comes from it:

```
invite secret = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|secret", L = 32)
seal key      = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|seal",   L = 32)
invite key    = from the invite secret, exactly as 03 §7.1
topic         = base64url(SHA-256(UTF-8("minca/door-topic/v1|" + compressed invite public key)))
```

- The **invite secret** is today's 32-byte secret. The `sys.invite` record,
  joining and closing (03 §7.2–7.3) don't change at all.
- A view-only invite gets an `S` too. Its invite key is used only for the
  mailbox (below); it has no record in the space.
- The **topic** is a door's topic (07 §4) over the invite key. The relay
  can't tell an invite from a door, and the purge it already checks (07 §5)
  works unchanged: whoever holds `S` can clear the topic.

128 bits is enough: the topic and the sealed blob are public to whoever asks
the relay, so `S` must resist offline guessing, and 2¹²⁸ does.

### 2. The sealed invite

What was the whole link is now the plaintext of a blob dropped in the
mailbox:

```json
{
  "v": 1,
  "at": 1790000000000,
  "invite": { "space": { … }, "key": "…", "role": "member", "relays": ["wss://relay.minca.social"] },
  "nodes": ["wss://host.example/peer#did:key:zDnae…"]
}
```

- `invite` is today's `SpaceInvite` (03 §7.4) without `invite` (the secret is
  in the link) and without `invitedBy` (unauthenticated today, and the space's
  history says who opened the invite).
- `nodes` are the always-on nodes the space is reached at, pinned by DID
  (04 §5.2). This is what fixes #220: the joiner dials them at once, and
  stops when the space's own records (`std.host`, `sys.hosting`) take over.
- `at` orders versions. The joiner takes the newest blob that opens.

```
blob = base64url( nonce(12) ‖ AES-256-GCM(seal key, nonce, deflate-raw(UTF-8(JSON)), aad = topic) )
```

Compressed with `CompressionStream("deflate-raw")`, a web standard in
browsers, Node and Bun. It must fit a mailbox blob: 12,000 characters
(07 §5), about 8.9 KB sealed, which compressed holds a large constitution.

No signature. Only a holder of `S` can make a blob that opens, and a holder of
`S` can already join; a relay can only withhold blobs or replay old ones
(below).

### 3. Where it is kept

The inviter drops the blob in the mailboxes of the space's relays
(`sys.relays`), its own relays, and its hosts. A host already serves a relay
on its address (04 §5.3), so it has a mailbox. The link names one or two of
them after `@`, as `host[:port][/path]` with `wss://` implied (`ws://` only
for `localhost`). A joiner asks the named mailboxes and its own relays.

Keeping it alive: a mailbox keeps a blob up to 14 days (07 §5) and may forget
it on a restart.

- The **inviter's devices** keep `S` for every open invite, in the account
  registry (03 §13), so any of them can drop the blob again, seal it again
  after a key change or a change of relays or hosts, and purge it when the
  invite is closed.
- **Hosts** keep it alive while every device is offline. The blob is already
  sealed, and dropping the same blob again needs no key. The account puts
  `{ topic, blob, mailboxes, until }` in each carrier's carry space
  (06 §4.2) next to the passes, and the carrier drops it again before it
  expires. It sees what any relay sees: a topic and ciphertext.

### 4. Joining

1. Read `S` and the mailboxes from the link.
2. Fetch the topic from each mailbox at once. Open every blob; ignore any that
   doesn't open; keep the newest by `at`.
3. Check it as an invite is checked today (03 §7.6): the constitution hashes
   to the id, a public space carries no key.
4. Join with the invite and the invite secret derived from `S`. Dial `nodes`
   and the relays at the same time.

Preview is steps 1–3. No blob found means the invite has expired or was
closed, and the joiner is told so.

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
meeting place is trusted with no more than a relay is.

This draft builds only the relay mailbox and the node address. The table is
there so the link format doesn't have to change when the others arrive: a
mailbox hint is a URL, and a plugin claims the schemes it knows.

## What a party learns

| Party       | Today                                  | With short invites                                                                                            |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Link holder | The space, its key, the right to join  | The same                                                                                                      |
| Relay       | Rooms, peers, door mailboxes           | Also: an invite's topic, its blob's size, when and from which address it is fetched. Not the space or its id. |
| Host        | Its spaces, sizes, which account asked | Also: that the account keeps an invite open, its topic, until when                                            |
| Chat app    | The whole invite, if it reads the URL  | The secret, if it reads the fragment; unfurlers don't                                                         |

What a relay can do to an invite:

- **Withhold it.** The joiner asks every mailbox named and its own; the long
  link is the fallback.
- **Replay an old version.** The joiner keeps the newest it can open.
  An old version's key may be stale after a key change; the joiner then
  holds a key that opens nothing new, as with an old long link.
- **Flood the topic** (64 blobs, 07 §5) so a fresh drop is refused. The
  inviter purges it; a host can't, and waits for the inviter.
- A closed invite whose blob a relay kept still holds the space key, as a
  long link copied before closing does. Closing stops the join (03 §7.2);
  only a key change stops reading.

## Changes to the spec

- **03 §7**: a new §7.7, the short link (secret, derivations, link format,
  sealed invite, joining). §7.4 says the long form stays.
- **03 §13.2**: the registry keeps open invites' `S`.
- **06 §4.2**: the carry space's invite record, and that a carrier drops it
  again.
- **07 §5**: the mailbox holds invites as well as knocks; nothing a relay does
  changes.
- **08 §4**: the "Invites that name the space's hosts" Planned text goes.
- **Threat model**: §3.7 Relay and §3.8 Host gain the rows above; §3.1
  Stranger is unchanged (a leaked link gives what it gave).

## Plan

1. `packages/core/src/space/invite-link.ts`: `deriveInviteLink(S)`,
   `encodeInviteLink`, `parseInviteLink`, `sealInvite`, `openInvite`. Tests
   with fixed vectors.
2. `packages/core/src/network/mailbox.ts`: nothing new; reuse `drop`, `fetch`,
   `purge`.
3. `packages/core/src/node/node.ts`: `spaces.invite` returns the short link
   (`{ long: true }` for the old one); `preview` and `join` accept both;
   `join` dials `nodes` until the space names its own; keep `S` in the
   registry, drop again before expiry, seal again on key, relay or host
   change, purge on `closeInvite`.
4. `packages/core/src/node/carrier.ts` and `host.ts`: read invite records in
   the carry space, drop them again.
5. Spec and docs as above; `packages/core/docs/spaces.md#invites`.
6. Apps: the shorter link and a QR code.
7. Tests:
   - a joiner with only a host online gets the space (fails today, #220);
   - blobs that don't open are ignored, the newest wins;
   - a closed invite's blob is purged, and a join after closing is refused;
   - after a key change the blob is sealed again and a new joiner reads;
   - with every device offline, the host keeps the blob past one TTL;
   - the long link still joins.

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
- **Signed contact cards for every keeper.** Useful once nodes move often;
  not needed while the inviter can seal the invite again.

## Prior art

- **Hypercore's blind pairing** (`holepunchto/blind-pairing-core`) is this
  design's nearest relative: a seed in the invite gives a key pair, and the
  invite id, the encryption key and the nonce are separate hashes of it. Its
  joiner checks that what it got hashes to what the invite named, as ours
  checks the constitution against the id.
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
  names where to look. The `@` hint is the same idea.

Each other network needs its own key: Nostr signs with Schnorr on
secp256k1, BEP 44 and Pkarr with ed25519. A plugin derives its key from `S`
with its own HKDF label, never from the P-256 invite key; `@noble/curves`
already has both.

## Open questions

- **How many mailboxes in the link.** One keeps it short; two survives one
  relay going away.
- **QR codes.** Uppercase base32 (26 characters for 16 bytes) fits a QR
  code's alphanumeric mode and makes it much smaller, but `#` and lowercase
  hosts don't. A QR code could carry `MINCA:` and the base32 secret, and the
  scanning app supply its own mailboxes.
- **The app's origin.** The link names an app (`minca.social/j`). Should any
  Minca app open any link, by a registered scheme or a shared path?
- **Rooms on public networks.** On Nostr or the DHT anyone who knows a
  space's id can watch its room. A private space's room there could come from
  its read seed, which changes with its key. Belongs to the Nostr and tracker
  plugins, not this draft.
