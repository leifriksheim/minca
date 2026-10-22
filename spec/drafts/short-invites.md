# Draft: short invites, and finding a space with nobody else online

Status: design, October 2026, revised after two adversarial reviews (below).
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
- **A link is fixed when it is made.** It names one exact invite. Nobody, the
  inviter included, can change what a joiner gets from it, and nobody can
  clear it. A key change ends it, as it ends a long link today.
- **Nothing new to trust.** A relay or host that keeps an invite holds
  ciphertext, and can only withhold it.
- **Simple.** A secret and a hash in the link; everything else derived from
  them.

## The design

**The link carries a key and a hash. The hash says which invite, and where
to look for it. The key opens it.**

```
https://minca.social/j#ohIu8keaS7VhX3p8HTc70P8q9ohX-_2RrbU1UUUVESo@relay.minca.social
                       └ secret (16 B) ┘└─ pin (16 B) ─┘           └ where it is kept ┘
```

The fragment is 43 characters, plus one or two places: about 85 in all,
against 800 to 1,500 today.

### 1. The link

The link's 32 bytes are `S ‖ pin`.

- `S` is 16 random bytes (128 bits). It must resist offline guessing, since
  the sealed invite is public to whoever finds it, and 2¹²⁸ does.
- `pin` is the first 16 bytes of `SHA-256(UTF-8(blob))`, the hash of the
  sealed invite's base64url text (§2) exactly as kept: the same hash a relay
  files a blob under (07 §5's `id`).

From them:

```
invite secret = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|secret", L = 32)
seal key      = HKDF-SHA256(S, salt = empty, info = "minca/invite-link/v1|seal",   L = 32)
topic         = base64url(SHA-256(UTF-8("minca/invite-topic/v1|" + base64url(pin))))   — 43 characters
```

- The **invite secret** is today's 32-byte secret. The `sys.invite` record,
  joining and closing (03 §7.1–7.3) don't change. Closing by link (03 §7.6)
  derives it from `S` first.
- A view-only link has an `S` too, used only for the seal key.
- The **topic** is a relay mailbox topic (07 §5), but no key hashes to it,
  so the relay's purge check never passes: **nobody can clear it**. Only
  someone who has the link or the blob can compute it; it is not in the
  space.

### 2. The sealed invite

```json
{
  "v": 1,
  "invite": { "space": { … }, "key": "…", "role": "member", "relays": ["wss://relay.minca.social"] },
  "nodes": ["wss://host.example/peer#did:key:zDnae…"],
  "until": 1790600000000
}
```

```
blob = base64url( nonce(12) ‖ AES-256-GCM(seal key, nonce, deflate-raw(UTF-8(JSON))) )
```

- `invite` is today's `SpaceInvite` (03 §7.4) without `invite` (the secret is
  in the link) and without `invitedBy` (unauthenticated, and the space's
  history says who opened the invite).
- `key` is the space key when the link was made. The blob is never sealed
  again: the pin would no longer match.
- `nodes` are always-on nodes that hold the space: at most 8, each a node URL
  pinned by DID (04 §5.2). This is what fixes #220. `relays` passes
  `checkRelays` (03 §10).
- `until` is optional: when the inviter wants the link to stop being served.
- Compressed with `CompressionStream("deflate-raw")`, a web standard in
  browsers, Node and Bun. A reader checks the seal before inflating, inflates
  as a stream and stops at 64 KiB. A sealed invite must fit a mailbox blob
  (12,000 characters, 07 §5); a constitution too large for that (up to 64
  roles of 64 grants) gets a long link instead.

No signature: the pin is stronger. A blob whose hash doesn't start with
`pin` is not this link's, whoever made it, and is ignored before it is
opened.

### 3. Where it is kept

The inviter drops the blob in the mailboxes of the space's relays
(`sys.relays`) and its own, under the topic. The link names at most two
places after `@`, separated by `,`: the account's host first when it has
one (its relay serves the mailbox, 04 §5.3), then a relay. A place is a URL,
percent-encoded where it holds `@`, `,` or `#`; written without a scheme,
`host[:port][/path]` means `wss://`, or `ws://` for `localhost`, `127.0.0.1`
and `[::1]`, and a plugin claims any other scheme. A joiner asks the places
named (at most three) and its own relays. Places are not in the pin: like
`relays` in a long link, anyone passing the link on can change them, which
can only point the joiner at a mailbox that withholds (#20).

A fetch reads every page of the topic, up to the relay's 64 blobs, not the
eight pages `mailbox.fetch` reads today: with 12,000-character blobs, 32 of
them would hide the real one.

A relay keeps a blob up to 14 days (07 §5) and may forget it on a restart.
Two things keep it longer, and neither holds `S`:

- **The account.** The inviter's device writes `{ space, invite?, keyId?,
blob, until? }` in the account registry (03 §13): the space's id, the
  invite DID (role links), and the id of the key the blob carries (private
  spaces). None of them is secret; the invite DID is already in the space.
  They let any of the account's devices act on the record without `S`. Any
  that is online drops the blob again when it is gone, only to relays it uses
  for that space anyway (`sys.relays` or its own, checked with
  `checkRelays`). An app holding the account sees ciphertext and ids, as a
  member does.
- **The host.** Each device keeps these records in step with its carriers'
  carry spaces (06 §4.2), as it does passes. A host's mailbox answers a fetch
  of the topic it computes from each record's blob, while the record is there
  and `until` has not passed. The account never names a topic, so it can't
  make the host answer for a door. The host drops nothing anywhere. It serves
  an account's 64 most recent records.

The device that made the link keeps `S` sealed under its local key (05 §15),
so the person can copy the link again; an app's node keeps it in the app's
own storage. `S` is never written to the registry or any space.

**What ends a link.** Only two things, and both are in the space:

- **Closing its invite** (03 §7.2), for a role link: no join counts after.
- **A key change**, for a private space: the blob's key no longer lets
  anyone read. When a key changes, a device holding the account closes the
  role invites of its records whose `keyId` is the old key, then deletes the
  records. Otherwise a member holding the new key could still join with the
  old link's secret, with that role.

`until` is weaker: when the account stops serving the blob. Its devices and
host stop, and the app closes a role invite at `until` once one of the
account's devices is online. But anyone who holds the blob can drop it again
anywhere, so `until` is no promise that a leaked link stops working; a
view-only link to a public space never stops. An app's expiry choice says
"stop sharing this link", not "this link stops working". A link with no
`until` is served while the record exists: right for a community that posts
its link and leaves it.

### 4. Joining

1. Read `S`, `pin` and the places from the link.
2. Fetch the topic from each place at once. Keep the blobs whose hash starts
   with `pin`. Two different ones mean the link is refused.
3. Open it, inflate it within the limit, and check it as an invite is checked
   today (03 §7.6); the constitution hashes to its id.
4. Join with the invite secret derived from `S`, and dial the nodes and relays
   at once.

The invite's nodes are kept with the space as its invite relays are, and
dialled until one answers `4003` (it doesn't hold the space) on reconnects
over a day. A host behind on a key change answers `4003` too, to a joiner
holding only the new key; that host is dropped, and the joiner's own
carriers or the space's keepers take over. They came from the inviter, as the relays did, so they get the
same trust. Whether a node that the space's own keepers don't name should
stay longer belongs to #220's keepers plan.

Preview is steps 1–3. No blob found means the link expired or its places are
gone; the joiner is told that, not that it was closed.

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
size of a torrent info hash. Peers prove who they are and that they may read
once connected (04 §6), so a meeting place is trusted with no more than a
relay is. A mailbox is trusted with less: the pin means it can only withhold.

Things on Nostr and the DHT expire unless published again (Nostr's
`expiration` tag, NIP-40; about two hours on the DHT), so short-lived links
suit them, and a host publishing again until `until` keeps longer ones.

This draft builds only the relay mailbox and the node address. The table is
there so the link format doesn't have to change when the others arrive.

## What a party learns, and can do

| Party       | Today                                  | With short invites                                                                                                                                  |
| ----------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link holder | The space, its key, the right to join  | The same: a leaked short link is a leaked invite, as a long one is, for as long as anyone serves its blob. It can't change or clear what others get |
| Relay       | Rooms, peers, door mailboxes           | Also: a topic, a blob's size, when and from which address it is fetched. A relay also in the space's room can tie a fetch to the room               |
| Host        | Its spaces, sizes, which account asked | Also: which account keeps which link, until when, and who fetches it                                                                                |
| Chat app    | The whole invite, if it reads the URL  | The secret, if it reads the fragment; unfurlers don't                                                                                               |

What a relay, or a link holder, can do to a link:

- **Withhold it.** The joiner asks every place named and its own relays; the
  host serves it from a record; the long link is the fallback.
- **Flood the topic** at a relay (64 blobs, 07 §5), so a drop after the
  inviter's blob expires is refused. Blobs a relay holds stay until they
  expire, and the host's copy isn't in the relay's queue. Takes 16 addresses
  an hour on the reference relay, or 8 to fill the pages a fetch reads today
  (§3); it joins [#162](https://github.com/leifriksheim/minca/issues/162).
- **Keep it served** past `until`, by dropping the blob again (§3).
- The nodes and relays the inviter named learn the joiner's address and, for
  a private space, its account (the hello's `member`, 04 §6.3), as a node the
  space names does today.

## Changes to the spec

- **03 §7**: a new §7.7, the short link (link format, derivations, sealed
  invite, joining); §7.4, the long form stays; §7.6, closing by a short link.
- **03 §13.2**: the registry record holding a link's blob ("secrets are never
  kept" still holds).
- **05 §15**: `S` sealed at rest on the device that made the link.
- **06 §4.2**: the carry space's copy of that record, and the host's mailbox
  answering for it.
- **07 §5**: the mailbox holds invite topics as well as door topics; a topic
  no key hashes to can't be purged; a host's mailbox also answers from
  carry-space records.
- **08 §4**: the "Invites that name the space's hosts" Planned text goes.
- **Threat model**: §3.7 Relay and §3.8 Host gain the rows above; §3.1 and
  §3.3 say a short link is a leaked invite for as long as anyone serves its
  blob, and that `until` promises nothing.

## Plan

1. `packages/core/src/space/invite-link.ts`: `encodeInviteLink`,
   `parseInviteLink`, `sealInvite`, `openInvite`, with fixed test vectors.
2. `packages/core/src/network/mailbox.ts`: nothing new; reuse `drop` and
   `fetch`.
3. `packages/core/src/node/node.ts`: `spaces.invite` returns the short link
   (`{ long: true }` for the old one, `until` optional); `preview` and `join`
   accept both; the registry record, dropping again when gone, closing the
   invite and deleting the record on a key change or at `until`; the copy in
   carry spaces; `mailbox.fetch` reads every page for invite topics.
4. `packages/relay/relay.mjs` (an option to answer a topic from elsewhere),
   `packages/cli/src/serve.ts` and `packages/core/src/node/host.ts`: the
   host's mailbox answers from carry-space records. The relay's duplicate
   check skips expired copies: today a drop in the 15 s before the sweep
   answers `dropped` and stores nothing, which 07 §5 doesn't allow.
5. Spec and docs as above; `packages/core/docs/spaces.md#invites`.
6. Apps: the shorter link, an expiry choice, a QR code.
7. Tests:
   - a joiner with only a host online gets the space (fails today, #220);
   - a link holder's blob, with a random key or other nodes, is ignored by
     the pin, and the joiner gets in (the second review's lockout);
   - nobody can clear the topic;
   - after a removal and a key change, the link no longer lets anyone read,
     and its record is gone;
   - with every device offline, the host serves the blob past a relay's TTL,
     and stops at `until` and when the record is deleted;
   - after a key change, a member holding the new key can't join with an
     old role link: its invite was closed;
   - 32 large junk blobs under the topic don't hide the real one;
   - an account's record can't make the host answer for a door's topic;
   - a blob that inflates past the limit is refused;
   - the long link still joins.
8. A scenario: the chess club, public and then private, posts a role link.
   A link holder tries to redirect it, clear it, and lock joiners out with a
   junk key; a removed member tries to keep reading.

## Adversarial review

Three reviews. Both blockers came from taking more than one blob on trust; the third found none.

**First review.**

| Finding                                                                                                   | What changed                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Blocker.** Sealing again after a key change gave a removed member the new key                           | Blobs are never sealed again. A key change ends a link, as today                                 |
| **Blocker.** Any link holder could clear the topic and replace the invite                                 | No key hashes to the topic, so nobody can purge it; the pin fixes the blob                       |
| The topic came from `sys.invite.key`, so whoever holds the space could find it                            | The topic comes from the pin                                                                     |
| A carrier's drop instructions could point a host at any server                                            | The host drops nothing; it answers from records                                                  |
| Keeping `S` in the registry broke "secrets are never kept" and §3.6                                       | `S` stays on the device that made the link; the registry holds only ciphertext                   |
| The nodes' stop condition named records a joiner never sees                                               | Rewritten in the second round                                                                    |
| `at` followed device clocks; "not found" claimed "closed"; deflate bombs; door-topic claim; `ws://` hints | `at` gone; wording fixed; inflating stops at 64 KiB; claim gone; plain `ws://` only for loopback |

**Second review.**

| Finding                                                                                                              | What changed                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Blocker.** A link holder's blob with a random key locked joiners out: the last key imported is the one proved with | The pin is the hash of the inviter's blob. Exactly one blob is taken; two that match refuse the link               |
| An account's record could make a host answer under any topic, a door's included                                      | The host computes the topic from the record's blob; the account names none                                         |
| Nodes and relays from other blobs steered and exposed joiners                                                        | Only the inviter's blob counts. At most 8 nodes, each pinned by DID; relays pass `checkRelays`                     |
| The keeper rule dropped an editor's host                                                                             | Invite nodes are kept as invite relays are, until the node says it doesn't hold the space                          |
| A registry record's `mailboxes` steered every device of the account                                                  | No `mailboxes`: devices drop only to relays they use for the space                                                 |
| Pin collisions; record kept after a key change; `S` at rest; inflating; place format; relay row; closing by link     | Two matching blobs refuse; record deleted on a key change; 05 §15; streaming; URLs with a default; row fixed; §7.6 |

**Third review.** No blockers.

| Finding                                                                                                   | What changed                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Joiners never asked the host, so its copy kept nothing alive                                              | The link names the account's host first                                                                                |
| Only the link's maker could act on `{ blob, until }`; deleting it on a key change left a role invite open | The record names the space, the invite DID and the key id; a key change closes those invites, then deletes the records |
| `until` was called an end, but anyone holding the blob can keep it served                                 | Said plainly: only closing and a key change end a link                                                                 |
| 8 addresses could hide the blob past the pages a fetch reads                                              | Invite fetches read every page; the relay's duplicate check skips expired copies                                       |
| Pin input; place syntax; which 64 records; size; `S` in apps; a host behind on a key change               | `UTF-8(blob)`; `@a,b`, percent-encoded; the 64 most recent; a long link when too big; the app's storage; noted         |

## Considered and not chosen

- **Hosts in the link.** Fixes #220, adds about 50 characters per host, and
  goes stale when a host moves.
- **Link = space id + secret, the rest from peers.** About 100 characters and
  no mailbox, but nothing can be previewed and the key has to be boxed to the
  invite key inside the space: a new protocol record.
- **Hosts on the relay mesh.** WebRTC on servers, and the relay's limits
  (256 rooms a socket, 50 messages a second) bite a host with many spaces.
- **Short codes held by one host** (`host/i/x7k2`). Short, but the invite
  lives or dies with that host. The `@` places get most of this.
- **A link the inviter can update.** It needs a key only the inviter holds
  and its hash in the link, and an update after a key change is exactly the
  first blocker. Make a new link instead.
- **Expiry enforced by peers.** Peers would compare the join's time with the
  expiry, and the joiner writes that time. Closing the invite is the hard
  stop; `until` is when to stop serving it.
- **Signed contact cards for every keeper.** Useful once nodes move often;
  not needed while links are fixed and short-lived.

## Prior art

- **Hypercore's blind pairing** (`holepunchto/blind-pairing-core`) is this
  design's nearest relative: a seed in the invite gives the lookup id and the
  encryption key as separate hashes, and the joiner checks what it got
  against what the invite committed to.
- **Signal's group links** carry a 32-byte master key and a 16-byte password
  in the fragment; the group's details sit encrypted on Signal's server,
  fetched by the password. The same split: a lookup and a separate key.
- **Magic Wormhole** keeps codes tiny with a PAKE against a party that is
  online. With nobody online, a mailbox needs a secret that resists offline
  guessing, so ours is 128 bits; Trystero, which hashes a password with no
  KDF, shows what happens otherwise.
- **Content addressing** (IPFS, BitTorrent's info hash): naming data by its
  hash lets any untrusted store carry it. The pin is that.
- **Nostr's outbox model** (NIP-65) and Matrix's `via=` hints: the address
  names where to look. The `@` places are the same idea.

Each other network needs its own key: Nostr signs with Schnorr on
secp256k1, BEP 44 and Pkarr with ed25519. A plugin derives its key from `S`
with its own HKDF label, never from the P-256 invite key; `@noble/curves`
already has both.

## Open questions

- **How many places in the link.** One keeps it short; two survives one
  relay going away.
- **QR codes.** Uppercase base32 (52 characters for 32 bytes) fits a QR
  code's alphanumeric mode and makes it much smaller, but `#` and lowercase
  hosts don't. A QR code could carry `MINCA:` and the base32 bytes, and the
  scanning app supply its own places.
- **The app's origin.** The link names an app (`minca.social/j`). Should any
  Minca app open any link, by a registered scheme or a shared path?
- **Rooms on public networks.** On Nostr or the DHT anyone who knows a
  space's id can watch its room. A private space's room there could come from
  its read seed, which changes with its key. Belongs to the Nostr and tracker
  plugins.
