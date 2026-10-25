# 07 — Inbox

A DID is a name, not an address: it is on everything an account signs, so
knowing it must not be enough to reach the account. Two people who share a
space can become contacts through it, with a knock left there
([03](03-spaces.md) §16). This part covers two people who share nothing yet.

An account's **inbox** is an address it hands out on purpose, and can
replace:

|                       | What it is                                                                                     | Who sees it                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Inbox key**         | A P-256 key pair knocks are sealed to, derived from the contact key and the inbox's `gen`      | Its public half: whoever has the code                                |
| **Inbox signing key** | A second P-256 key pair, derived likewise, that signs the code and proves ownership of the box | Its public half: whoever has the code; its hash is the inbox's topic |
| **Places**            | 1–3 relays whose mailboxes hold knocks on it                                                   | Whoever has the code                                                 |
| **Inbox code**        | A `sys.inbox` loose version holding the two public keys, `gen`, the places and a name          | Whoever it is given to                                               |

Someone holding a code **knocks**: they make a private space for the two of
them, and leave a `sys.knock` carrying its signed invitation, sealed to the
inbox key, in the inbox's mailboxes. The owner's devices fetch knocks, check
them, and **accept** one by joining the space. Joining is the answer: only the
holder of the inbox key could open the invite.

This part specifies what a relay and an inbox's owner check: the keys, the
code, the topic, the mailbox and the knock. Where an account keeps its inbox's
settings, and how a knock becomes a contact on each side, are a convention on
top: see [Inbox](../packages/core/docs/inbox.md) in the library's docs.

The account behind an inbox is never in the code, the topic, or anything a
relay holds. The knocker learns it when the owner joins.

Lengths in this part count Unicode code points; text MUST be shortened without
splitting one.

> Rationale: this is Nostr's outbox model (the address names its own relays,
> so relays never need to know about each other) with SimpleX-style addresses
> (an address is a revocable queue on servers the recipient picked, not an
> identity). No relay can take an inbox down while another it names is up, and
> an owner whose relays all go away names others, or replaces the inbox.

---

## 1. Inbox keys

Both of an inbox's keys are derived from the account's **contact key**
([01 — Identity](01-identity.md) §10.3) and the inbox's generation, `gen`:

```
ikm         = contact key private scalar (32 bytes)
inbox key   = P-256 scalar from HKDF-SHA-256(ikm, salt = empty, info = UTF-8("minca/p256-inbox-key/v1|" + gen), L = 48)
signing key = P-256 scalar from HKDF-SHA-256(ikm, salt = empty, info = UTF-8("minca/p256-inbox-sign-key/v1|" + gen), L = 48)
```

The 48 bytes are reduced to a scalar exactly as the root key is
([01 — Identity](01-identity.md)).

- `gen` is a whole number from 0, written in decimal. Replacing the inbox is
  taking the next `gen`: codes for the old one still read, but nothing sealed
  to them is opened any more, and nothing ties the two inboxes together.
- Public halves are **compressed** P-256 points (33 bytes), base64url (44
  characters): the same form as a contact key's.
- The inbox key is used only for ECDH (opening knocks). The signing key is
  used only for ECDSA P-256 / SHA-256 signatures: over the inbox code (§3) and
  the purge message (§5). Neither is used for the other job.

Every device and app that holds the contact key derives the same inbox keys.
The contact key's public half is published on the account's profile in every
space it writes in; an inbox's keys are not, and nothing links them.

_Source: `packages/core/src/identity/contact-key.ts` (`deriveInboxKeyBytes`, `deriveInboxSignKeyBytes`, `signingKeyOf`, `signWithScalar`, `verifyWithPoint`). Tests: `packages/core/tests/inbox.test.ts` ("an inbox code")._

## 2. The inbox's settings

Not protocol: an account keeps which `gen` its inbox is at, its places and
its name as a `std.inbox` record in its own contacts space, which only its
devices read. See [Inbox](../packages/core/docs/inbox.md) in the library's
docs.

## 3. The inbox code

An inbox code is a loose version ([02](02-records.md) §3.5) in `sys.inbox`,
signed by the inbox's own signing key, for itself:

```
code = base64url( UTF-8( canonicalJSON(inbox) ) )
```

- `author` is the `did:key` of the signing key (`sign` below), and there is
  no `proof`: nothing in the code names the account.
- The body:

| Field    | Type                 |                                                             |
| -------- | -------------------- | ----------------------------------------------------------- |
| `key`    | string               | The inbox key's public half                                 |
| `sign`   | string               | The inbox signing key's public half; MUST differ from `key` |
| `gen`    | integer ≥ 0          | Which inbox of the account's this is                        |
| `places` | string[], 1–3        | Mailbox URLs; see below                                     |
| `name`   | string ≤64, optional | Who the owner says they are. **It proves nothing.**         |

A reader MUST accept a bare code, or a link carrying one as `inbox=<code>`
after `#`, `?` or `&` (e.g. `https://app.example/#inbox=eyJhdXRob3Ii…`), and
MUST refuse a code unless:

1. it is a valid loose version in `sys.inbox` (02 §3.5) with no `proof`;
2. its `author` is the `did:key` of `sign`;
3. its body has no member outside the table; `key` and `sign` are valid P-256
   points, and differ; `gen` is a whole number from 0; `places` holds 1–3
   relay URLs that pass the space relay check (each `wss://`, or `ws://` on
   localhost only, at most 200 characters, no duplicates); `name`, when
   present, is a string of at most 64 characters.

A signed code means nobody passing it on can change where knocks go, or the
name it shows, without the owner's signing key.

Example: the contact key of [01](01-identity.md) §10.1, `gen` 0, the record
key `aaaaaaaaaaaaaaaaaaaaaaaaaa` and the time fixed. Inbox key scalar
`3eb6fe8cd7d3d571c860e3867262a326d0f6337a6e5b2f23ec8894c6b7712bff`, signing
key scalar `d439cfa23bbb48af5cac7e829c00683812d3adf402868a994a8bbc9527790001`,
topic `HxW8ECmsKlUka0UEOGFx8bgChj6ToCYTOreTaBnVCtY`. The code, decoded (the
signature varies; any valid one verifies):

```json
{
  "id": "bdcf6dsnoxnzjnoeyc5q5o7sceaxswkb5pwsk5jhgm4zyvuf64zma",
  "author": "did:key:zDnaetEy5TtXJYGtyxUAzR7a7Uj6H4aVcNgULLRxPuNMBtWJK",
  "collection": "sys.inbox",
  "createdAt": "2026-10-01T12:00:00.000Z",
  "key": "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "seq": 0,
  "bodyHash": "bfxrrrcuuku34hhu3clsxab3afxgijzrcrqtd46fzilkluoljfuza",
  "body": {
    "key": "Az7e4Rrb7cRwOBUTo2R3DHPN_XhU_eEELZCaHnEdENoo",
    "sign": "A5014XmFHNvGb4sJVDmiDas-v4R4QJFmBRsO-N1lEMNY",
    "gen": 0,
    "places": ["wss://relay.example"],
    "name": "Anna"
  },
  "signature": "Q9Wrz4jPqhDYjXpB8vz5m9YrvWxXiyyTg7E9AM7F8vY6t7bNYLgK8mHBpgyqxnZ1IJB5atvHrTtGrsz5KyP9qw"
}
```

> Rationale: a code in a URL goes in the fragment, like an invite, so it isn't
> sent to the server that serves the page.

_Source: `packages/core/src/inbox/inbox.ts` (`encodeInbox`, `readInbox`, `inboxProblem`, `inboxAuthor`), `packages/core/src/records/loose.ts` (`checkLoose`). Tests: `packages/core/tests/inbox.test.ts` ("an inbox code")._

## 4. Topics

An inbox's knocks are filed under its **topic**, a hash of its signing key:

```
topic = base64url( SHA-256( UTF-8("minca/inbox-topic/v1|" + sign) ) )     — 43 characters
```

A relay can check that whoever clears a topic holds the key it came from (§5),
without learning anything else. Knowing a topic lets anyone fetch its sealed
blobs, which open only with the inbox key.

_Not yet specified:_ topics that change over time (e.g. per week), so a relay
can't follow one inbox across months.

_Source: `packages/core/src/inbox/inbox.ts` (`inboxTopic`)._

## 5. The relay mailbox

Every relay ([04 — Network](04-network.md)) also runs a mailbox. It speaks JSON
text frames on the same WebSocket endpoint as signaling. A mailbox socket
needs no `join` and names no DID.

### Messages

**drop** — leave a blob under a topic.

```json
→ { "type": "drop", "topic": "<43 chars>", "blob": "<base64url>", "ttl": 1209600 }
← { "type": "dropped", "topic": "<topic>", "id": "<base64url SHA-256 of blob>" }
← { "type": "refused", "topic": "<topic>", "reason": "<plain words>" }
```

- `blob` MUST be non-empty base64url, at most 12,000 characters.
- `ttl` is seconds, optional. The relay keeps a blob for its own TTL or the
  client's, whichever is shorter; a client can't ask for more.
- The relay files the blob under `id = base64url(SHA-256(UTF-8(blob)))`, and
  records `at`, when it took it (ms). Dropping a blob already held under that
  topic MUST answer `dropped` with the same id and store nothing new. A copy
  past its TTL is not held, even before the relay sweeps it away.

**fetch** — read a topic's blobs.

```json
→ { "type": "fetch", "topic": "<topic>", "after": 0, "watch": false }
← { "type": "mail", "topic": "<topic>", "items": [ { "seq": 17, "id": "…", "at": 1790000000000, "blob": "…" } ], "more": false }
```

- `items` are the unexpired blobs with `seq > after`, oldest first. `seq`
  increases with every drop on that relay. The relay pages them (the
  reference relay: at most 16 items or 48 KiB of blobs a page); `more: true`
  means fetch again after the last `seq`.
- With `watch: true`, the relay also sends a `mail` message with one item each
  time a blob is dropped under the topic, until the socket closes or the client
  sends `{ "type": "unwatch", "topic": "<topic>" }`. A relay may cap the
  watches on one socket and ignore the rest (see Limits).

**challenge / purge** — the inbox's owner clears knocks.

```json
→ { "type": "challenge" }
← { "type": "challenge", "nonce": "<24 chars>" }
→ { "type": "purge", "topic": "<topic>", "sign": "<signing key public half>", "ids": ["<id>", …], "sig": "<base64url>" }
← { "type": "purged", "topic": "<topic>", "count": 2 }
```

- `sig` is the inbox signing key over
  `UTF-8("minca/inbox-purge/v1|" + topic + "|" + nonce + "|" + ids)`, where
  `ids` is the ids sorted and joined with `,`, or `*` when `ids` is absent
  (clear everything).
- The relay MUST check that `topic` is the hash of `sign` (§4) and that `sig`
  verifies against `sign`, and MUST refuse otherwise. A nonce is good for one
  purge on the socket that asked for it, whether or not the purge succeeds.

A relay MUST ignore mailbox messages whose `topic` is not 43 base64url
characters (no answer).

### Limits

Blob size and blobs per topic are the same on every relay. Every other limit
is the relay operator's to set; a client learns of one only from `refused`
(or, for watches, from silence). The values below are the reference relay's.
An **address** is an IPv4 address or an IPv6 /64.

| Limit                                  | Value                                                                              | On breach             |
| -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------- |
| Blob size                              | 12,000 chars (every relay)                                                         | `refused`             |
| Blobs per topic                        | 64 (every relay)                                                                   | `refused`             |
| Drops per topic per address per hour   | 4                                                                                  | `refused`             |
| Drops per address per hour, all topics | 30                                                                                 | `refused`             |
| Topics held                            | 50,000                                                                             | `refused`             |
| Total held                             | 64 Mi chars, plus a reserve of 8 Mi only topics holding fewer than 2 blobs may use | `refused`             |
| TTL                                    | 14 days                                                                            | capped                |
| Watches per socket                     | 32                                                                                 | extra watches ignored |

The socket's message budget, size cap and heartbeat are the relay's usual ones
([04 — Network](04-network.md)).

A full inbox refuses new knocks rather than dropping old ones, so a flood
can't push out real knocks; a full relay still takes a knock or two on every
inbox, from the reserve. An owner whose inbox is flooded clears it (purge),
which keeps its code working.

> **Known defect:** both budgets are weaker than this section and §8 promise.
> One IPv6 /64 counts as one address, so a home /56 (256 of them) can fill the
> mailbox within an hour. And a topic holding no blobs may use the reserve, so
> knocks on random new topics can spend it, after which a full relay takes no
> knock on an existing inbox. A fix budgets IPv6 at /64, /56 and /48 together,
> and keeps the reserve for topics that existed before the mailbox filled.
> Other implementations SHOULD NOT copy these limits. Tracked in
> [#162](https://github.com/leifriksheim/minca/issues/162).

A relay need not keep its mailbox across a restart (the reference relay keeps
it in memory), which is one reason a knock goes to every place an inbox names.

**Short links.** The mailbox also keeps sealed invites under a short link's
topic ([03](03-spaces.md) §7.7). The relay can't tell them from knocks, and
does nothing different. No key hashes to such a topic, so a purge of it always
fails: nobody can clear it. A host's relay also answers a fetch with the
links its accounts keep ([06](06-nodes-and-sessions.md) §4.2).

_Source: `packages/relay/relay.mjs` (`handleMail`, `purge`, `sweepMail`, `MAILBOX_LIMITS`, `mailboxFrom`), `packages/core/src/network/mailbox.ts`. Tests: `packages/core/tests/inbox.test.ts` ("the relay's mailbox"), `packages/core/tests/invite-link.test.ts` ("a mailbox that keeps blobs for others", "nobody can clear it…")._

## 6. Knocks

### The knock

A knock is a loose version ([02](02-records.md) §3.5) in `sys.knock`, signed
by the knocker's session key under its account's note, with `to` the key it
is sealed to: an inbox key (§1), or a contact key when left in a space both
belong to ([03](03-spaces.md) §16). Its body:

| Field    | Type                   |                                                                                                 |
| -------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `invite` | object                 | The invitation ([03](03-spaces.md) §7.4) to a private space for two the knocker made, as signed |
| `secret` | string                 | Its invite secret (03 §7.1), base64url: 43 characters                                           |
| `name`   | string ≤64             | The name they give (defaults to "Someone"); nothing vouches for it                              |
| `note`   | string ≤2000, optional |                                                                                                 |

```
sealed = HPKE(to, "minca/mail/v1", { to }, UTF-8(JSON(knock)))
```

`HPKE` is sealing to a key ([01 §9.2](01-identity.md)): to `to`, with label
`minca/mail/v1` and bound `{ "to": <that key> }`. The blob is
`base64url(0x01 ‖ ephemeral point (65 bytes) ‖ ciphertext)`. A sealed knock
MUST fit a mailbox: 12,000 characters (§5).

A knocker drops a knock as soon as it signs it.

### Opening a knock

A recipient MUST treat a blob as a knock only if all of these hold, and
otherwise ignore it. `receivedAt` is the relay's `at` for the blob; a knock
left as `sys.mail` has none.

1. It opens with one of the recipient's keys (an inbox key it holds, or its
   contact key for `sys.mail`), label `minca/mail/v1`, bound
   `{ "to": <that key's public half> }`; and the knock's `to` is that key.
2. It is a valid loose version in `sys.knock` (02 §3.5): its signature checks
   out, and its note, when it carries one, is valid at its `createdAt`.
3. **Authority.** Its note, when it carries one, grants `/account/write` for
   the account as a whole, with arguments `{}` ([01](01-identity.md) §8): a
   note to write for the whole account. An app given some spaces, or a key
   given records only, may not knock. With no note its author is the account.
4. **Time.** `createdAt` is no more than 14 days before now; and, from a
   mailbox, no more than 5 minutes after `receivedAt` and no more than 10
   minutes before it.
5. `name` is a string of at most 64 characters, `note` when present one of at
   most 2000, and `secret` 43 base64url characters.
6. `invite` checks out as an invitation (03 §7.4), and speaks for the same
   account as the knock; its space is private and it carries the space key;
   its space's constitution names that account as its one founder and
   assigns no roles ([03](03-spaces.md) §1.1); it names a `role`; and the space checks out (its id is the hash of
   its constitution).

A mailbox knock's **id** is `base64url(SHA-256(UTF-8(blob)))`, the same on
every relay. A client MUST de-duplicate by it, computing it itself rather
than trusting a relay's `id`. Each relay's copy is judged by the `receivedAt`
that relay gives, and the knock counts when any copy passes: one relay that
lies about when it took a knock can't hide it while another tells the truth.
The cost is that one relay willing to give a `receivedAt` as old as a
backdated knock's `createdAt` lets a note that ran out knock (§8).

The constitution's checks say only that the knocker founded the space alone
and assigned nobody a role in it; its history may since have given others
places. Who else holds one shows once the recipient has joined.

Which of the knocks that pass these checks a client offers the person
(leaving out blocked accounts, for one) is up to it; see
[Inbox](../packages/core/docs/inbox.md).

> Rationale.
>
> - A space's genesis isn't signed, so the invite alone could not prove who
>   made it. The knock's signature under the account's note proves it came
>   from that account before anyone joins anything, as a record's does, and
>   the invitation, signed under the same account, says the same of the
>   relays and nodes it names. `to` is signed, so whoever opens a knock can't
>   seal it again to another key and pass it off as sent there.
> - **Authority (3):** knocking makes a space and hands out its invite, so it
>   needs what making spaces for the account needs: a note that grants
>   `/account/write` for the whole account.
> - **Time (4):** notes are judged when a knock was signed, since knocks are
>   read days later, long after an hour-long session note ran out. But
>   `createdAt` is the signer's word. Tying it to when the relay took the
>   knock, a time the inbox's owner picked the keeper of, means a note that ran
>   out can't be used by dating a knock back to when it was good. A `sys.mail`
>   knock has no such time; its record is judged in its space like any other.

_Source: `packages/core/src/inbox/inbox.ts` (`sealKnock`, `openKnock`, `knockId`), `packages/core/src/space/invitation.ts` (`checkInvitation`), `packages/core/src/identity/abilities.ts`. Tests: `packages/core/tests/inbox.test.ts` ("a knock")._

## 7. The exchange

Not protocol: where an account keeps its inbox's settings (`std.inbox`) and
the knocks it left (`std.knock`), and how each side turns a knock into a
contact, are records a peer syncs and judges like any other. See
[Inbox](../packages/core/docs/inbox.md) in the library's docs.

There is no answer record. The recipient accepts by joining the space for two
with the knock's invite (03 §7.6). The knocker takes the first account other
than its own that holds a place there as the contact, and closes the invite
(03 §7.2). An account home MUST NOT give the contact key with a note that
grants records only ([06 §2.8](06-nodes-and-sessions.md)).

## 8. Security considerations

- **One inbox, not linked to the account.** An account has one inbox at a
  time. Its keys are derived from the contact key, not published on any
  profile, so someone who holds the code and shares a space with the account
  can't tell from the code that it is theirs. Replacing it (a new `gen`)
  gives keys nothing ties to the old ones.
- **What a relay learns.** Topics, blob sizes and times, and the addresses of
  the sockets that drop, fetch and purge, so it can see that some address
  knocked on a topic that another address fetches. Not whose inbox it is, not
  which account knocked, not what was said. Topics are stable per inbox (§4).
- **What a knocker learns.** The code's name, which is only what the owner put
  there. The owner's account only once they join.
- **What the owner learns.** The knocker's account, proven, and the name and
  note they chose. The name proves nothing: the account DID is what to trust,
  and a code handed over in person is the proof of whose inbox it is.
- **A changed code.** A code is signed by its own signing key (§3), so whoever
  passes it on can't change its places or name. They can hand out a code of
  an inbox of their own in its place: only where the code came from says
  whose it is.
- **Spam.** Anyone with a code can knock. On the reference relay, each
  address gets 4 knocks per inbox and 30 in all per hour; each inbox holds 64.
  A single IPv6 /56 holds 256 /64s, so a determined flood can fill one inbox:
  its owner **clears** it, which keeps every printed code and bio link
  working, or replaces it. Blocking hides an account's knocks everywhere. A
  knock only shows as a request; nothing in it runs.
- **Filling a relay.** The per-address budget across topics bounds what one
  address can hold; the reserve keeps every inbox able to take a knock or two
  when the relay is full; the TTL can't be raised by clients. Both budgets are
  weaker than that today (see the known defect in §5).
- **Authority.** Only a proof that grants `/account/write` for the whole
  account can knock (§6). A note that ran out can't be used by backdating
  unless a relay the inbox names gives a `receivedAt` as old as the backdated
  knock: copies are judged one relay at a time (§6), so one relay can't hide
  a knock, but one that colludes with whoever holds the expired note can let
  it through. _Known limitation:_ a note that was **revoked** but hasn't run out yet
  (an app disconnected at the home, whose note lasts up to its grant's days)
  can still knock, because the owner can't see the knocker's revocations.
  Revoking a session's note when it ends is planned in
  [01 §7.6](01-identity.md) ([#165](https://github.com/leifriksheim/minca/issues/165)).
- **Leaked invites.** The invite in a knock is multi-use until the knocker
  closes it. Nothing but the space tells the knocker who joined: whoever joins
  first is taken as the contact, and the invite is closed then. Doors had an
  answer, signed with the door's key, that told the person behind the door
  from anyone else the invite reached; the inbox has none. Only the inbox key
  opens the knock, so someone else joins first only if the recipient's key or
  device leaked, the recipient passed the invite on, or an app the recipient
  gave the contact key to (06 §2.8) joined first: the inbox keys are derived
  from it. The knocker sees whoever joined under their own account, never
  under the recipient's, though they may give the recipient's name.
- **Replays.** A knock re-dropped by anyone is the same blob (same id).
  Dropped again later, it fails the time check (§6, 4).
- **Losing a relay.** An inbox names up to three places, and knocks go to all
  of them. A relay can drop knocks but can't read, forge or alter them, nor
  hide one that another relay the inbox names holds (§6).

## 9. Planned: names

> **Planned.** Not normative. A handle that leads to an inbox, so a person can
> paste `@anna.bsky.social`, sent to them anywhere, where a code works today.

A name is a pointer to an inbox, never to the identity. It resolves to an
inbox code, and never to the account DID: that would link everything the
account ever signed to the handle. The first name provider is ATProto, whose
handles are domains checked both ways against a DID. ATProto is used only to
publish one record, never to sign in: its signing keys usually live with the
PDS, the opposite of "the seed is the account".

**Resolving a handle** (read only, no sign-in):

1. **Handle → DID.** DNS TXT `_atproto.<handle>` (`did=did:plc:…`), else
   `https://<handle>/.well-known/atproto-did`. Browsers can't read TXT
   records: use the HTTPS path, then a configurable DNS-over-HTTPS resolver.
   The DID document's `alsoKnownAs` MUST name the handle back.
2. **DID → PDS**, from the DID document's `AtprotoPersonalDataServer` service
   (`did:plc` through the PLC directory, `did:web` through the domain).
3. **PDS → inbox.** `com.atproto.repo.getRecord`, collection
   `org.minca.inbox`, key `self`:
   `{ "$type": "org.minca.inbox", "code": "<inbox code>", "createdAt": "…" }`.
   The repository is signed, so the record is the handle owner's word, and the
   code is signed by the inbox's own key (§3).

**A checked handle on a knock.** A knock gains an optional `handle` and a
`handleProof`: the knocker's own inbox signing key over
`minca/knock-handle/v1|<inbox key knocked on>|<knock createdAt>`. The owner
resolves the handle, reads the knocker's own inbox record, and checks the
proof against the `sign` key in that code. This proves the knocker controls
the handle's repository and an inbox, without their account DID becoming
public.

**Linking a handle** happens at the account home: ATProto OAuth (PAR, PKCE,
DPoP) asking only to write `org.minca.inbox`; the home writes the account's
inbox code into the record. Unlinking deletes it; replacing the inbox writes
the new code.

How a client knocks on a handle, shows a checked one, and lets an inbox's
owner limit who may knock is planned in
[Inbox](../packages/core/docs/inbox.md).

**Trade-offs.** The PLC directory, a DoH resolver and `bsky.social` owning its
subdomains become dependencies of _discovery_ only: contacts already made are
Minca spaces and survive them. An inbox record makes "this handle uses Minca"
public, which is opt-in. A second provider should follow: plain DNS,
`_minca.<domain>` TXT holding an inbox code, for people with a domain and no
ATProto account.

## 10. Not yet specified

- **Topics that change over time** (§4).
- **Proof of work** on `drop`, if public relays see abuse.
- **Revocation** checks on a knocker's note (§8).
- **Several inboxes at once**, so an account can hand out ones nobody can
  link to each other.
