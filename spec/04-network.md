# 04 — Network

How peers find each other and talk: relays, of more than one kind, and the
sealed messages peers meet with through them; using several relays at once;
the relays a space names for itself; the transports (WebRTC data channels, a
WebSocket to an always-on node); the handshake that proves who is at the other
end of a connection; the mesh that shares connections between spaces; peers
introducing peers; live messages; and ICE/TURN.

What travels _inside_ an authenticated connection — the sync protocol — is
in [05 — Sync and storage](05-sync-and-storage.md). Keys, DIDs and notes
(delegations) are in [01 — Identity](01-identity.md). Read keys, space
keys, roles and the access log are in [03 — Spaces](03-spaces.md). What an
inbox and a short link keep in a relay's mailbox is in [07 — Inbox](07-inbox.md).

```
        ┌──────── relay: a Minca relay (wss://) or a Nostr relay (nostr+wss://) ────────┐
        │  blobs under a topic: handed to watchers (ttl 0), or kept to be fetched        │
        │  it sees topics and sealed bytes, never who meets whom                          │
        └──────────▲─────────────────────────────────────────────────────▲───────────────┘
                   │ sealed: hello, offer, answer (§2)                    │
   peer A ── WebRTC data channel "data" (binary frames of UTF-8 JSON) ── peer B
            │ per room: __auth-hello ×2, __auth-proof ×2, then who, sync, live, …
            │ introductions: __peers, __signal (offers for third parties)

   peer ── WebSocket  wss://node/peer?space=<id>  ── always-on node
            challenge → hello → welcome (text), then binary frames of UTF-8 JSON
```

Terms used below:

- **session DID** — the `did:key` of the session key a node signs with
  ([01 — Identity](01-identity.md)). It is a peer's identity on the wire:
  in handshakes and in every message's `from`.
- **account DID** — the root DID behind a session, proven by the session's
  **note**: its proof, one token from the account's root key to the
  session key ([01](01-identity.md) §7.5).
- **room** — a name peers meet under, derived from what they share (a space
  id, a channel's secret).
- **topic** — what a relay knows a room by: a hash of the room (§1.3).
- **space id**, **read key**, **space key** — see [03 — Spaces](03-spaces.md).

---

## 1. Relays

A relay moves sealed blobs under a topic. It holds no data of any space, has
no authority, understands nothing it carries, and is trusted for nothing but
liveness: a relay that lies can at worst fail to pass a blob on, pass on an
old one, or make one up, all of which the peers catch (§2, §6).

### 1.1 What every relay does

Every relay, of every kind, does two things:

- **Publish and watch.** A blob published under a topic goes to whoever
  watches that topic now, and is kept by nobody. Peers meet this way (§2).
- **Drop and fetch.** A blob dropped under a topic is kept for a while, to be
  fetched later. Inboxes and short links use this ([07](07-inbox.md),
  [03](03-spaces.md) §7.7).

> Rationale: a relay is a pipe, not an authority. Asking it for nothing more
> lets any infrastructure that moves bytes by topic carry Minca, so a space
> stays reachable when one operator goes away.

### 1.2 Kinds of relay

A relay is named by a URL whose scheme says its kind:

| Scheme                                    | Kind                   |
| ----------------------------------------- | ---------------------- |
| `wss://`, or `ws://` on this machine      | a Minca relay (§1.4)   |
| `nostr+wss://`, or `nostr+ws://` likewise | a Nostr relay (§1.5)   |
| `<kind>+wss://`, any other kind           | not specified; ignored |

A valid relay URL is a string of at most 200 characters that parses as a URL
whose scheme is `wss:`, or `<kind>+wss:` with `<kind>` matching
`^[a-z][a-z0-9-]*$`; or the same with `ws` in place of `wss` when the host is
`localhost`, `127.0.0.1` or `[::1]`. A client dials the URL with `<kind>+`
taken off the scheme. A client MUST pass over a relay of a kind it doesn't
speak, and MUST NOT treat a list naming one as invalid for that, so a space
can name a new kind before every member's app speaks it.

_Source: `packages/core/src/network/relays.ts` (`relayKind`, `createRelayLink`, `createMailboxClient`), `packages/core/src/network/relay-socket.ts` (`dialOf`), `packages/core/src/space/roles.ts` (`checkRelays`). Tests: `packages/core/tests/rendezvous.test.ts` ("a relay of a kind this library does not speak is passed over")._

### 1.3 Rooms and topics

**A space's room** is derived from its id:

```
room = lowercase( base32( SHA-256( UTF-8("minca-room/v1|" + spaceId) )[0..20) ) )
```

`base32` is RFC 4648 (alphabet `A–Z2–7`), no padding, output lowercased. 20
bytes give exactly 32 characters. Other protocols meet in rooms of their own,
with names derived elsewhere: the channel's rooms (`channelRoom`,
[01 — Identity](01-identity.md) §15.2), for device pairing and for connecting
by code ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md) §3).

A room never goes to a relay. A relay knows it by its **topic**, and what is
said in it is sealed under its **room key**; both are derived from the room,
so only those who know the room can find it or read it:

```
topic    = base64url( SHA-256( UTF-8("minca/rendezvous-topic/v1|" + room) ) )   43 characters
room key = SHA-256( UTF-8("minca/rendezvous-key/v1|" + room) )                 an AES-256-GCM key
```

Example: space id `example-space-id` → room
**`tr3o3btwwyb36pwbt3bcr3za7o5kn76p`** → topic
**`wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0`**, room key
`f77dffde0d511f9b164fdd119414e55ba836574e8810a3d4f1bad1be98643c1e` (hex).

A client MUST use these derivations; two implementations that differ here
never meet.

_Source: `packages/core/src/node/space-runtime.ts` (`relayRoom`), `packages/core/src/network/rendezvous.ts` (`rendezvousKeys`), `packages/core/src/utils/hash.ts` (`base32Encode`). Tests: `packages/core/tests/space-relays.test.ts`, `packages/core/tests/rendezvous.test.ts`._

### 1.4 A Minca relay

A Minca relay is a public WebSocket server: the reference relay runs on its
own, and inside every always-on node.

- It accepts a WebSocket upgrade on **any path** (the always-on node
  reserves `/peer` for itself, §5.3, and hands every other path to its relay).
- `GET /health` answers `200` with `{"ok":true}` (`content-type:
application/json`). It MUST NOT reveal how many topics or sockets exist.
- Any other plain HTTP request answers `426` with a text body.
- All messages are **text frames** carrying one JSON object each. Binary
  frames are counted against the rate budget (§1.4, Limits) and otherwise
  ignored. Text that is not a JSON object with a string `type` is ignored.
- A socket never says who it is.

Before a socket is opened, the relay MAY refuse the upgrade with a plain HTTP
response and `Connection: close`:

| Status | Reason phrase          | When                                                      |
| ------ | ---------------------- | --------------------------------------------------------- |
| `503`  | `Relay full`           | the relay holds `MAX_CONNECTIONS` sockets                 |
| `429`  | `Too many connections` | the client address holds `MAX_CONNECTIONS_PER_IP` sockets |

The client address is the TCP peer address, or the address a proxy the relay
runs behind reports; anywhere else a header is whatever the client says. How
the reference relay is started, configured and told it runs behind a proxy is
in [`packages/relay/README.md`](../packages/relay/README.md).

#### Messages

A **topic** is 43 base64url characters; a message naming any other is
ignored. A **blob** is non-empty base64url of at most 12,000 characters.

| Client → relay                                  | Effect                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: "drop", topic, blob, ttl: 0 }`         | **Publish**: from a socket watching the topic only, the blob goes to every _other_ socket watching it, as `mail` with one item `{ blob }`. Nothing is kept, and the sender gets no answer. A socket not watching the topic is ignored.                                           |
| `{ type: "drop", topic, blob, ttl? }`           | **Drop**: the blob is kept, under `id = base64url(SHA-256(UTF-8(blob)))`, for the relay's own time or `ttl` seconds, whichever is shorter. Answered `dropped` (also for a blob already held under that topic, which stores nothing new) or `refused`. Watchers get it as `mail`. |
| `{ type: "fetch", topic, after?, watch? }`      | **Fetch**: the kept blobs with `seq > after` (default 0), oldest first, a page at a time. With `watch: true` the socket also hears, from now on, every blob published or dropped under the topic, until it closes or sends `unwatch`.                                            |
| `{ type: "unwatch", topic }`                    | Stops watching.                                                                                                                                                                                                                                                                  |
| `{ type: "challenge" }`, `{ type: "purge", … }` | An inbox's owner clears it ([07](07-inbox.md) §5).                                                                                                                                                                                                                               |
| `{ type: "ice" }`                               | Ask for TURN servers (§1.4, TURN passwords). Ignored from a socket that watches no topic, and by a relay without TURN.                                                                                                                                                           |
| `{ type: "ping" }`                              | Ask whether the socket still reaches the relay. A relay SHOULD answer `pong`.                                                                                                                                                                                                    |

| Relay → client                                     | Meaning                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: "dropped", topic, id }`                   | The blob is kept.                                                                                                                         |
| `{ type: "refused", topic, reason }`               | It was not, and why, in plain words.                                                                                                      |
| `{ type: "mail", topic, items, more }`             | Blobs: `items` of `{ seq, id, blob }` for kept ones, `{ blob }` for a published one. `more: true` means fetch again after the last `seq`. |
| `{ type: "ice", payload: { servers, expiresAt } }` | TURN servers, and when their passwords stop working (ms since the epoch).                                                                 |
| `{ type: "pong" }`                                 | The answer to a `ping`.                                                                                                                   |

`seq` increases with every blob the relay keeps. A copy past its time is not
held, even before the relay sweeps it away. A relay need not keep anything
across a restart (the reference relay keeps it in memory).

```json
→ {"type":"fetch","topic":"wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0","watch":true}
← {"type":"mail","topic":"wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0","items":[],"more":false}
← {"type":"ice","payload":{"servers":[{"urls":["turn:turn.example.com:3478"],"username":"1790000000:3q2-7wX0aBcD","credential":"n3Jk…="}],"expiresAt":1790000000000}}
→ {"type":"drop","topic":"wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0","blob":"AZ3k…","ttl":0}
← {"type":"mail","topic":"wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0","items":[{"blob":"AV9q…"}],"more":false}
→ {"type":"ping"}
← {"type":"pong"}
```

#### Limits

A relay is open to anyone and MUST bound what one client can cost it. Every
value below is the reference relay's; a compatible relay MAY choose others,
and clients MUST tolerate being refused or cut off at any of them. What a
relay does on exceeding a limit is as the last column says, whatever its
value. The limits on kept blobs are the mailbox's, in [07](07-inbox.md) §5.

| Limit                              | Reference value               | On exceeding                                                                     |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Message size (`MAX_MESSAGE_BYTES`) | 64 KiB                        | the WebSocket library closes the socket (1009)                                   |
| Open sockets, whole relay          | 5 000                         | upgrade refused `503 Relay full`                                                 |
| Open sockets per client address    | 32                            | upgrade refused `429 Too many connections`                                       |
| Topics watched, whole relay        | 10 000                        | a watch of a new topic is ignored                                                |
| Sockets watching one topic         | 64                            | the watch is ignored                                                             |
| Topics one socket watches          | 256                           | the watch is ignored                                                             |
| Message rate per socket            | token bucket: 50/s, burst 100 | socket terminated with no close frame                                            |
| Heartbeat                          | ping every 15 s               | a socket that did not pong since the last ping is terminated, and its watches go |
| Send buffer per recipient          | 1 MiB                         | the _recipient_ is terminated rather than buffered for                           |
| Addresses holding a TURN password  | 20 000                        | new addresses get no `ice` until old passwords expire                            |

Every message counts against the rate budget, including binary and malformed
ones. A published blob goes to at most 63 other watchers, so one socket can
have the relay send up to 63 times what it sends.

#### TURN passwords

A Minca relay MAY hand out TURN credentials for a TURN server (coturn run
with `use-auth-secret`) that shares a secret with it — the "TURN REST API"
scheme, in which nothing is stored and nothing needs revoking.

```
expires    = floor(now_seconds) + ttlSeconds
username   = decimal(expires) + ":" + base64url(9 random bytes)      (12 chars after the colon)
credential = base64( HMAC-SHA1( key = secret, message = UTF-8(username) ) )   (standard base64, padded)
```

The relay sends `{"type":"ice","payload":{"servers":[{"urls":[…TURN_URLS],"username":"<username>","credential":"<credential>"}],"expiresAt":<expires × 1000>}}`
unprompted to a socket when it first watches a topic, and on each `ice` from a
socket that watches one. A relay MAY hand one username to every socket of one
network, so that coturn's per-user quota caps a network rather than each
request; the reference relay does. A relay without TURN never answers `ice`.

_Source: `packages/relay/relay.mjs` (`upgrade`, `clientIp`, `handleMessage`, `handleMail`, `watch`, `offerTurn`, `turnFromEnv`, `networkOf`, `withinBudget`, heartbeat), `packages/relay/signaling-server.mjs`, `packages/cli/src/serve.ts` (`serve`), `packages/core/src/network/relay-minca.ts`. Tests: `packages/core/tests/rendezvous.test.ts` ("the relay keeps nothing dropped with ttl 0"), `packages/core/tests/relay-turn.test.ts`, `packages/core/tests/inbox.test.ts`, `packages/cli/tests/cli.test.ts` ("answers /health…", "is a relay too…")._

### 1.5 A Nostr relay

A Nostr relay speaks NIP-01. Blobs travel as the `content` of events, with
the topic in an `x` tag:

| What    | Event                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------ |
| Publish | kind **24733** (ephemeral: relays pass it on and keep nothing), tags `[["x", topic]]`            |
| Watch   | `["REQ", <id>, { "kinds": [24733], "#x": [topic], "since": <now − 120, s> }]`; stop with `CLOSE` |
| Drop    | kind **4733**, tags `[["x", topic], ["expiration", "<unix seconds>"]]` (NIP-40)                  |
| Fetch   | `["REQ", <id>, { "kinds": [4733], "#x": [topic], "limit": 500 }]`, read until `EOSE`             |

- Every event is signed as NIP-01 requires, by a **throwaway** secp256k1 key,
  a fresh one for each event, so nobody watching a public relay can tell by
  the key that two rooms' events came from one node. Who a peer is is
  proven end to end once connected, and every blob is sealed, so the key
  proves nothing and a receiver need not check it.
- A drop is done when the relay answers `["OK", <event id>, true, …]`, or
  `false` with a reason starting `duplicate:`. A drop's expiration is the
  dropper's time to live, or 14 days.
- A fetched blob's `id` is `base64url(SHA-256(UTF-8(content)))`, computed by
  the fetcher. Events past their `expiration` are not taken. A fetch reads
  one page, the newest 500 the relay gives, so more than 500 blobs dropped
  after it bury the older ones (threat model §3.7).
- A relay that asks for authentication (NIP-42, `["AUTH", <challenge>]`) is
  answered with a kind 22242 event from the same throwaway key, tagged
  `relay` and `challenge`; what it refused before is sent again.
- A Nostr relay hands out no TURN passwords, and nobody can clear events
  someone else signed, so an inbox kept there can't be purged
  ([07](07-inbox.md) §5).

```json
[
  "EVENT",
  {
    "id": "5c1e…",
    "pubkey": "9a41…",
    "created_at": 1790000000,
    "kind": 24733,
    "tags": [["x", "wXBid3pUqrPtazKRrLpWmkZp2Yo78jdDlSUx_3PweR0"]],
    "content": "AZ3k…",
    "sig": "e07b…"
  }
]
```

_Source: `packages/core/src/network/relay-nostr.ts` (`createNostrLink`, `createNostrMailbox`, `signNostrEvent`, `NOSTR_EPHEMERAL_KIND`, `NOSTR_HELD_KIND`). Tests: `packages/core/tests/relay-nostr.test.ts`, against the NIP-01 relay in `packages/core/tests/helpers/nostr-relay.ts`._

---

## 2. Meeting in a room

A node in a room watches the room's topic on every relay it uses for that
room, and publishes there, sealed under the room key:

```
blob    = base64url( sealEnvelope( room key, "minca/rendezvous/v1", { topic }, UTF-8(JSON(message)) ) )

message = { "kind": "hello", "id", "at", "from", "box" }
        | { "kind": "offer" | "answer", "id", "at", "from", "box", "to", "sdp" }
sdp     = sealTo( box of `to`, "minca/rendezvous-signal/v1", { topic, from, to, box }, UTF-8(JSON(description)) )
```

`sealEnvelope` is the symmetric envelope and `sealTo` sealing to a key
([01](01-identity.md) §9.1, §9.2).

| Field  | Value                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------- |
| `id`   | 12 random bytes, base64url: what makes copies of one message one                                        |
| `at`   | when it was sent, ms since the epoch                                                                    |
| `from` | the sender's session DID                                                                                |
| `box`  | a P-256 public key the sender made for meeting, compressed, base64url; the private half never leaves it |
| `to`   | the DID an offer or answer is for                                                                       |
| `sdp`  | the `RTCSessionDescriptionInit`, with every ICE candidate in it, sealed to the recipient's `box`        |

A receiver MUST ignore a blob unless all of these hold:

1. It opens under the room key, label `minca/rendezvous/v1`, bound
   `{ topic }`, and is a JSON object.
2. `from` is a `did:key` other than its own, and `box` a point on P-256.
3. `id` is a string of at most 64 characters it has not acted on in this
   room (it remembers a bounded number of recent ids per room, and records
   one only once its message passed every other check), and `at` is within
   2 minutes of its own clock.
4. For an offer or answer: `to` is its own DID, and `sdp` opens with its box,
   label `minca/rendezvous-signal/v1`, bound `{ topic, from, to, box }` with
   the message's own `box`.

What it does then:

- **`hello`**: `from` is in the room. If `from` is the greater DID (compared
  as strings) the receiver offers to it (§7.3); otherwise it says hello
  back, at most once every 10 seconds in that room, so the lesser one hears
  of it and offers.
- **`offer`, `answer`**: handed to the mesh as a signal from `from` (§7.3).

A receiver remembers, per room, each peer it heard and the `box` it last
used there. A room holds at most **64** peers, and a peer not heard from in
5 minutes is forgotten; a hello or signal from a new peer in a full room
MUST be ignored. An offer goes only to the room whose hello prompted it,
sealed to the box last heard for that peer in that room; an answer goes only
to the room its offer came in, sealed to the box the offer carried. The `sdp` seal binds the
sender's own `box`, so a message re-wrapped with another box opens nothing.

> Rationale: a hello costs nothing to send, and anyone who knows the room can
> say one under any number of made-up names. A relay's room used to hold 64
> sockets; holding 64 peers keeps that bound, so a flood can fill a room but
> not make a node dial without end.

A node says hello when it joins a room, on each relay whenever that relay's
socket (re)opens, and SHOULD say it again every 2 minutes while in the room,
since relays keep nothing and a hello may be lost. There is no goodbye: a peer
is gone when its connection is (§5).

```json
{
  "kind": "hello",
  "id": "Hq3pW0x1b7Zc2LkA",
  "at": 1790000000000,
  "from": "did:key:zDnaeV1Sz…",
  "box": "A7Hq0J1xV2bqkZfHkC0Y0n1kQ4p3c3nWm0C0H2Hn3m0f"
}
```

> Rationale: a relay that can read who is in a room learns who meets whom,
> and one that can read an offer learns every peer's addresses. Sealed under
> the room key, a relay sees a topic; sealed again to one peer's box, others
> in the room don't see that peer's addresses either. One rule for who offers,
> the same as for introductions (§8), means both sides hearing each other's
> hello never makes two connections.

_Source: `packages/core/src/network/rendezvous.ts` (`createRendezvous`, `rendezvousKeys`, `remember`, `MAX_ROOM_PEERS`), `packages/core/src/network/mesh.ts` (`meet`), `packages/core/src/network/introductions.ts` (`shouldInitiate`, `createSeenSignals`). Tests: `packages/core/tests/rendezvous.test.ts` ("hellos under 90 made-up names start no more than 64 connections", "an offer re-wrapped with another box opens nothing", "a relay, or anyone on the topic, sees neither who meets nor their addresses", "a third peer in the room hears the offer pass but cannot open it", "a blob that does not open under the room key, or is stale, or comes again, is ignored", "a replayed hello counts once"), `packages/core/tests/network-manager.test.ts` ("the mesh, through real relays")._

### 2.1 Keeping a relay's socket

- While it is in any room, a client SHOULD keep redialling a relay whose
  socket closed, however many attempts fail. A client that stops is still
  signed in and still looks online, but no peer can find it until it
  restarts, and it has no way to tell.
- A socket can die without closing: after a sleep or a network change the
  relay has let go of it, while the client still holds it open, alone. So a
  client SHOULD close its sockets and redial when it wakes from a sleep longer
  than a relay keeps a silent socket (two heartbeats, §1.4), or comes back
  online. That asks nothing of the relay, so it works with any.
- A client MAY also `ping` a Minca relay on a socket that has heard nothing
  for a while, and close and redial one whose relay has answered a `ping`
  before but has sent nothing since the last two.
- On opening a socket, the client watches every topic it should again: a
  relay forgets everything when a socket closes.
- A client SHOULD pace what it sends below a relay's message budget, so that
  watching every room again and saying hello in each doesn't get its socket
  cut off; the reference client sends at most 20 messages a second, in bursts
  of 40.
- A Minca relay's `ice` is kept only if it has the right shape: `servers` an
  array (only the first 4 considered), each with `urls` (string or array) of
  which only strings shorter than 256 characters matching `^turns?:` are
  kept, and string `username` and `credential`; `expiresAt` a finite number.
  An offer with no usable server is dropped.

How often the reference client redials, and how it reports each relay's
state, is in [the node's docs](../packages/core/docs/node.md#the-network).

_Source: `packages/core/src/network/relay-socket.ts` (`createRelaySocket`, `iceFrom`, `SEND_PER_SECOND`), `packages/core/src/network/relay-minca.ts`, `packages/core/src/network/relay-nostr.ts`. Tests: `packages/core/tests/relay-socket.test.ts`, `packages/core/tests/rendezvous.test.ts` ("a node in 60 rooms keeps its relay…")._

---

## 3. Several relays at once

A client MAY be configured with several relays, of any kinds. It uses **all
of them at once**, not in order: it connects to every one and watches every
room's topic on every one. Connecting succeeds once any relay answers, and
fails only when none does.

> Rationale: failover still strands two people when one is on the first
> relay and the other on the second. Being present on all of them means they
> meet wherever either is looking.

- A message goes to every connected relay the room is on. The same message
  arriving through several relays is acted on once, by its `id` (§2, rule 3).
- **TURN.** `ice` offers are kept per relay; the client's TURN servers are
  the union of all relays' servers, expiring at the earliest `expiresAt`.
  A request for TURN (`ice`) goes to every connected relay that has TURN.

_Source: `packages/core/src/network/rendezvous.ts`. Tests: `packages/core/tests/rendezvous.test.ts` ("two peers on two shared relays hear each other once, and an offer arrives once, opened"), `packages/core/tests/network-manager.test.ts` ("a relay connects the first pair…")._

---

## 4. A space's own relays

A space may name the relays its members meet on, so that people whose apps
are configured with different relays still meet.

- They are the body of the single record with key `relays:space` in the
  collection **`sys.relays`**: `{ "relays": [url, …] }`, stored in the clear
  even in a private space. It is part of the access log and only an author
  granted `/space/relays` may change it; see
  [03 — Spaces](03-spaces.md) for how the current value is chosen.
- A valid list has at most **8** entries, no duplicates, each a valid relay
  URL (§1.2), of a kind the client speaks or not. An invalid list is not
  applied.

```json
{ "relays": ["wss://relay.example", "nostr+wss://relay.damus.io"] }
```

A node joins a space's room on **its configured relays plus the space's
relays**, the latter for that room only. Until the space names some, it uses
the relays named by the invite that brought it
([03 — Spaces](03-spaces.md)). When the list changes, the node watches the
room's topic on the new relays and stops on relays no longer named.

How the reference node closes sockets no room needs, and names relays for a
space it manages, is in [the node's docs](../packages/core/docs/node.md#the-network).

_Source: `packages/core/src/space/roles.ts` (`RELAYS_COLLECTION`, `MAX_RELAYS`, `checkRelays`), `packages/core/src/space/space-access.ts` (`SPACE_RELAYS_RECORD`), `packages/core/src/node/space-runtime.ts` (`useRelays`, `nameRelays`, `setRelays`), `packages/core/src/network/rendezvous.ts` (`join`, `release`), `packages/core/src/network/mesh.ts` (`useRelays`). Tests: `packages/core/tests/space-relays.test.ts`, `packages/core/tests/network-manager.test.ts` ("a room that names its own relay…")._

---

## 5. Transports

A transport moves opaque byte messages between this node and peers named by
their session DID. Two kinds exist:

- **Signalled** (WebRTC): a connection starts with an offer and an answer
  carried by something else — a relay or a peer (§8).
- **Unsignalled** (a WebSocket to an always-on node): it dials by itself and
  authenticates by itself.

On every transport a message is **one binary frame containing UTF-8 JSON**.
Transports do not fragment, compress or re-order messages. Not yet
specified: a maximum message size on peer connections other than the limits
of §9.

_Source: `packages/core/src/network/transport.ts`. Tests: `packages/core/tests/network-manager.test.ts`._

### 5.1 WebRTC data channels

- The offerer creates **one data channel labelled `data`**, `ordered: true`
  (reliable, in order). The answerer uses the channel it receives. Messages
  are binary (`binaryType = 'arraybuffer'`); text messages are ignored.
- ICE candidates are not trickled: each side gathers its candidates (the
  reference node waits for gathering to finish, or 2 s) and sends them inside
  its offer or answer. A connection takes one message each way.
- A connection counts as open when the data channel opens, and as gone when
  the channel closes or the connection state becomes `failed` or `closed`.
- One connection per peer: making or accepting a new one for a peer closes
  any existing one with it.
- **Channel binding.** Each side takes, from the local and the remote
  session description, the first `a=fingerprint:<alg> <value>` line and
  renders it as `lowercase(alg) + " " + uppercase(value)`, e.g.
  `sha-256 3A:9F:…:C1`. These two strings bind the peer handshake to this
  connection (§6.2). A transport without certificates has no binding; both
  strings are then empty.
- The ICE servers are asked for each new connection, since TURN passwords
  change (§10).

_Source: `packages/core/src/network/rtc-transport.ts`. Tests: none directly; the mesh tests replace WebRTC with the fake signalled transport in `packages/core/tests/helpers/fake-transport.ts`._

### 5.2 WebSocket to an always-on node (client side)

Browsers cannot accept connections, but they can dial a node with a DNS name
and a TLS certificate. A client dialling one holds one socket to it **per
space**, to

```
<node URL>?space=<encodeURIComponent(spaceId)>        (&space=… if the URL already has a query)
```

e.g. `wss://node.example.com/peer?space=abc123`. The node appears as a
single peer, named by its session DID.

**The URL.** A node URL MUST be `wss://`, or `ws://` only to `localhost`,
`127.0.0.1` or `[::1]`: anywhere else, someone on the way could answer in the
node's place. A client MUST refuse any other URL without dialling it.

**Pinning the node.** A node URL MAY pin the node by a DID in its fragment:

```
wss://node.example.com/peer#did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169
```

The fragment is the DID itself, percent-decoded. The client strips it before
dialling, so the node never sees it, and puts `?space=` before it. A fragment
that is not a `did:key:` makes the URL unusable. With a pin, the client MUST
refuse (close `4002`) a welcome unless:

- the node DID is the pinned DID (a node that signs with its own key, as a
  host does); or
- the welcome's `note` is a valid note (01 §7.5, checked at the client's
  time, §7.6) whose audience is the node DID, whose issuer is the pinned
  DID, and which grants a node's whole power: `cmd` is `/`, `sub` is the
  pinned DID, and `pol` is `[]`. This is how a node whose session key
  changes on restart, such as `minca run`, is pinned by its account. A
  narrower note, an app's for one space or for reading only, is not the
  account's node and MUST NOT satisfy the pin.

> **Known defect:** any key whose note grants everything about the account,
> an app given write to every space included, satisfies an account pin, and
> the client checks no revoke of it. Tracked in
> [#165](https://github.com/leifriksheim/minca/issues/165).

A client SHOULD pin a host by the key its `sys.hosting` record names, or, for
a host it only knows by address, by the `did` its description gives
([06](06-nodes-and-sessions.md)).

The handshake is three text frames, then binary frames either way:

```
1. node   → client   {"type":"challenge","nonce":<Nₛ>,"did":<node DID>}
2. client → node     {"type":"hello","did":<client session DID>,"nonce":<N꜀>,"sig":…,"read"?:…,"readKey"?:…,"member"?:…,"earlier"?:[…]}
3. node   → client   {"type":"welcome","did":<node DID>,"sig":<…>,"note"?:<the node's proof>}
4. binary frames of UTF-8 JSON, either way
```

The proof fields and what is signed are in §6.1. The client:

- MUST refuse (close `4002`, "protocol error") a first frame that is not a
  `challenge` with a string `nonce` and non-empty string `did`, and a second
  that is not a `welcome` with a non-empty `did`;
- MUST refuse a welcome whose `did` differs from the challenge's, or whose
  `sig` does not verify (§6.1);
- MUST process frames one at a time, so no data frame overtakes the welcome;
- ignores text frames after the welcome.

How the reference client redials is in [the node's docs](../packages/core/docs/node.md#the-network).

_Source: `packages/core/src/network/ws-transport.ts` (`nodeAddress`), `packages/core/src/network/peer-auth.ts` (`checkPin`, `pinned`), `packages/core/src/node/node.ts` (`pinnedTo`, `peerOf`), `packages/core/src/node/space-runtime.ts` (`nodeNetwork`), `packages/core/src/network/network-manager.ts`. Tests: `packages/core/tests/ws-transport.test.ts` ("pinning the node", "only a note for everything about the account pins…"), `packages/cli/tests/host.test.ts`, `packages/cli/tests/cli.test.ts` ("a device that pins the node by its account…")._

### 5.3 The `/peer` endpoint (node side)

An always-on node serves `/peer` on the same port as its relay.

1. On upgrade the node MUST send the `challenge` at once — before looking at
   whether it holds the space — with a fresh nonce and its **session DID**.
   A node that does not hold the space refuses the hello exactly as it
   refuses a stranger.
2. It waits for one text frame. Close codes:

| Code   | Reason                                    | When                                                                                                                     |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `4000` | `missing ?space=`                         | no `space` query parameter                                                                                               |
| `4008` | `no hello`                                | no frame within the node's wait (10 s in the reference node)                                                             |
| `4002` | `expected a hello frame`                  | binary, not JSON, `type` ≠ `hello`, `did` not matching `^did:key:z[1-9A-HJ-NP-Za-km-z]{1,250}$`, or `nonce` not a string |
| `4003` | `not a reader of this space`              | the node does not serve the space, or the proof fails (§6.1)                                                             |
| `1011` | `could not open space` / `internal error` | the node failed                                                                                                          |
| `4009` | `replaced by a newer connection`          | the same DID connected again in this space; the older socket is closed                                                   |
| `1001` | `node shutting down`                      | —                                                                                                                        |

3. On success it sends the `welcome` and treats the socket as the peer named
   by the hello's `did`. Only binary frames are data; text frames are
   ignored.

A node MAY bound the size of a frame on `/peer`; the reference node closes
the socket (`1009`) on a frame over **16 MiB**. A client MUST tolerate being
cut off there.

_Source: `packages/cli/src/serve.ts` (`onPeer`, `parseHello`, `createSpacePeers`), `packages/core/src/node/node.ts` (`authenticator`), `packages/core/src/node/host.ts`. Tests: `packages/cli/tests/host.test.ts`, `packages/cli/tests/cli.test.ts` ("two devices that are never online together converge through it"), `packages/core/tests/key-change.test.ts`._

### 5.4 In-process links

Not protocol: two peers in one process never meet another implementation.
The reference library's in-process link is in [the node's docs](../packages/core/docs/node.md#the-network).

---

## 6. Peer authentication

Nothing in an offer or a WebSocket URL proves who is at the other end. So on
every connection, and before a byte of a space crosses it, each side proves
the session DID it claims by signing with **the key that DID names**, and in
a private space proves it may read, by signing with the space's **read key**.

Common rules:

- Nonces are 16 random bytes, base64url (22 characters).
- Signatures are ECDSA P-256 / SHA-256, 64-byte P1363, base64url
  (86 characters), over the UTF-8 bytes of a label below.
- A signature is checked against the public key decoded from the DID
  ([01 — Identity](01-identity.md)); a DID that does not start with
  `did:key:` or does not decode fails.
- `spaceId` in a label is the **space id**, not the room.

### 6.1 Client and node (WebSocket, `minca-peer/v3`)

```
H  = "minca-peer/v3|client|" + spaceId + "|" + clientDid + "|" + nodeDid + "|" + Nₛ
W  = "minca-peer/v3|server|" + spaceId + "|" + nodeDid + "|" + N꜀
```

- The client's hello carries `sig` = client session key signs `H`.
- The node MUST verify `sig` against `clientDid`. In a private space it MUST
  also check the read proof (§6.3) over the same `H`.
- The welcome carries `sig` = node session key signs `W`. The client MUST
  verify it against the node DID from the challenge.
- A node whose key acts for an account SHOULD also send its note as
  `note`, so a client can pin the account (§5.2). It is not covered by `sig`
  and need not be: it is checked on its own, and binds to the node DID that
  `sig` verified.

> Rationale: naming the node in `H` keeps a hello from being replayed to a
> different node; `W` proves the welcome comes from the node that issued the
> challenge. Which node to trust at all is the client's choice of URL, and its
> pin (§5.2).

_Source: `packages/core/src/network/peer-auth.ts` (`createClientAuth`, `createServerAuth`). Tests: `packages/core/tests/ws-transport.test.ts` ("a public space", "a private space", "a node that does not welcome properly is refused"), `packages/core/tests/key-change.test.ts` ("the current key lets you in; an old one only with a note…")._

### 6.2 Between peers (mesh, `minca-mesh/v1`)

Run once per room on a WebRTC connection (§7.2 gives the frames):

```
A → B   __auth-hello  { nonce: Nₐ }
B → A   __auth-hello  { nonce: N_b }
A → B   __auth-proof  proof over T(A, B, N_b)
B → A   __auth-proof  proof over T(B, A, Nₐ)

T(prover, verifier, nonce) =
  "minca-mesh/v1|" + spaceId + "|" + proverDid + "|" + verifierDid + "|" + nonce
                  + "|" + proverCert + "|" + verifierCert
```

`proverCert` / `verifierCert` are the channel-binding fingerprints of §5.1,
each as its owner's end: the prover signs with `(local, remote)` as it sees
them; the verifier checks with `(remote, local)` as it sees them. Without a
binding both are empty strings.

A proof is `{ "sig": …, "read"?: …, "readKey"?: …, "member"?: …, "earlier"?: […] }`, `sig`
being the prover's session key over `T`. The verifier MUST check `sig`
against the prover's DID and, in a private space, the read proof (§6.3)
over the same `T`.

In a room that asks no proof (a channel's room, pairing or connecting by
code, which secures its own payloads), the hellos are still exchanged and no proofs are sent.

Example (public space, placeholder fingerprints; the prover signs with the key of the seed of sixteen `07` bytes, the author of [02](02-records.md) §3.4; the verifier holds the key of sixteen zero bytes):

```
T = "minca-mesh/v1|example-space-id|did:key:zDnaemCBstFw5hzNdNggFHZm6GpHoHqNGrwEtrVi9CxGH9V7E|did:key:zDnaenhB7GpWm1sDUA2mcNLjbZG85bD5uv8kXnX39YE9rGV3d|_8bGsP1hPeS2r_CFgK10jg|sha-256 AA:BB|sha-256 CC:DD"
proof = {"sig":"TajJEwHsk_JRk6cPhnN3l0dbvZB6aCYtaIX_d2aHjDKqxJPtbdmv99hK3DcpW1mwwvJOwAQR1jNi9ouUFuLSEA"}
```

> Rationale: someone in the middle holds a different certificate pair on
> each side, so a proof relayed through them does not check out. A relay that
> swaps in its own offer is caught.

_Source: `packages/core/src/network/peer-auth.ts` (`createMeshAuth`), `packages/core/src/network/mesh.ts` (`onHandshake`). Tests: `packages/core/tests/network-manager.test.ts` ("every peer proves who it is, in every room"), `packages/core/tests/carrier.test.ts`._

### 6.3 Proving you may read a private space

In a private space the space names a current **read key** (`did:key`, from
`sys.key`; derivation in [03 — Spaces](03-spaces.md)). A reader adds to its
proof:

- `read` — the signature, over the same label (`H` or `T`), of the newest
  read key it holds.
- `readKey` — the DID of that read key. A reader MUST send it whenever it
  knows the DID: a reader that missed a key change believes its key is
  current, and cannot tell.
- `member` — its **note** sealed with the space key behind `readKey`. A
  reader SHOULD send it whenever it holds that space key, for the same
  reason:

  ```
  member = base64url( envelope(sealKey, "minca/membership/v1", { space: spaceId },
                               UTF-8(JSON.stringify(proof))) )
  ```

  where `sealKey` is the seal key of that space key ([03](03-spaces.md) §8.1) and
  the envelope is [01 §9.1](01-identity.md).

- `earlier` — the same signature by each **older** read key it still holds,
  newest first, at most 4: `[{ "readKey": <DID>, "read": <signature> }, …]`.
  The verifier may be the one that missed a change. A reader SHOULD send it
  when it holds older keys.

The verifier:

1. takes `claimed = readKey` if present, else the current read key;
2. verifies `read` against `claimed` (a `claimed` not starting with
   `did:key:` fails this step);
3. accepts if that holds and `claimed` is the current read key, except that
   while a new key is due ([03](03-spaces.md) §9.2) it rejects a prover whose
   `member` it can open to a valid proof (01 §7.5), made out to the prover's session DID,
   whose root account is a **former member** (03 §9.2);
4. accepts if that holds and it holds the space key whose read key is
   `claimed`, can open `member` with it, the proof inside is valid, is made
   out to the prover's session DID, and its root account is a reader of the
   space now. A verifier without that key (a host) cannot;
5. otherwise accepts only if an entry among the first 4 of `earlier` names
   the current read key and its `read` verifies against it;
6. rejects.

Example — the key changed K0 → K1 while Bob was away. Bob holds K0 and calls
it current; Alice holds both. Bob proves
`{"sig":…,"read":<K0 signs T>,"readKey":<K0 DID>,"member":<note sealed with K0>}`:
Alice accepts it by step 4. Alice proves
`{"sig":…,"read":<K1 signs T>,"readKey":<K1 DID>,"member":…,"earlier":[{"readKey":<K0 DID>,"read":<K0 signs T>}]}`:
Bob accepts it by step 5. The two sync, and Bob learns K1 from the history.

A node that must prove read access but holds no read key MUST NOT complete
the mesh handshake.

**Letting a reader go.** The check above runs once, at the handshake; a
verifier MUST keep it true for as long as the peer stays connected. The
verifier remembers the read key it let each peer in on: `claimed` when it
accepted by step 3 or 4, the current read key when by step 5. Whenever its
access history changes, and when a peer connects, it looks again at every
peer it let in on a key that is no longer current. It keeps such a peer only
if the account that peer showed in its `who` (§6.4) is a reader of the space
now; it lets go of every other one at once: it leaves the room for that peer
alone (`__leave`, §7.2) on the mesh, and closes the peer's socket on a node.
Nothing else of the space is sent to it. A peer whose `who` has not arrived
is given **10 s** from its handshake to send one, and is looked at again when
it does; after that it counts as having no account, and is let go of.
A peer let go of that reconnects is checked like any other, and a removed
member is then refused (steps 4 and 5 fail).

**While a new key is due.** Until someone who manages the space changes the
key, a former member (03 §9.2) may still hold the current one. Whenever its
access history changes, and when a peer's `who` arrives, a verifier that
knows a new key is due MUST let go of every peer whose `who` shows a former
member, whatever key it was let in on, and send it nothing more. It SHOULD
turn away that session when it reconnects, for as long as the key is still
due. Once a newer key is in force the rule above does the work, and someone
invited back, who holds the newer key, is let in again.

Example: Carol is removed and the key changes K0 → K1. Carol and Bob are
both connected, let in on K0. Bob is still a member, so he stays, and learns
K1 from the history. Carol is no reader, so she is let go of at once, and
when her node redials with K0 and her note, step 4 refuses her.

> Rationale: a removed member holds the key she was let in on, so a key
> change alone stops her reading new records, but not the connection: she
> would still be pushed new versions (sealed, but with their collections,
> keys and authors in the clear, [03](03-spaces.md) §8.6), live messages,
> which are not sealed, and whatever the history says next. Until the key
> changes she still holds the current key, so the peers that know she is
> out stop sending to her: only one that hasn't heard yet, or a node whose
> `who` she withholds, can still reach her. A public space asks no read
> proof, so letting someone go there would keep nobody out.

> Rationale: someone removed holds the older key too, but is no member. The
> note sealed under the older key shows which account is asking, and only
> those who could read the space then can open it. Step 5 lets in nobody a
> verifier would not already let in: it proves the key that verifier calls
> current. Without steps 4 and 5 applying to readers that don't know they
> are behind, a node that missed a key change could never reconnect, since
> the peers that could tell it about the change refuse it.

_Source: `packages/core/src/network/peer-auth.ts` (`proveRead`, `checkRead`, `MAX_EARLIER_READ_KEYS`), `packages/core/src/node/space-runtime.ts` (`readAccess`, `letGoOfOutsiders`, `formerMembers`, `cutOff`), `packages/core/src/network/mesh.ts` (`drop`), `packages/core/src/network/network-manager.ts` (`drop`), `packages/core/src/privacy/space-encryption.ts` (`MEMBERSHIP_LABEL`), `packages/core/src/identity/envelope.ts` (`sealValue`, `openValue`). Tests: `packages/core/tests/key-change.test.ts` ("with nobody here to change the key…", "proving you may read, while a new key is due"), `packages/core/tests/ws-transport.test.ts` ("a private space"), `packages/core/tests/network-manager.test.ts` ("in a private space, a peer without its key never becomes a peer"; "after the space key changed"; "letting a peer go in one room…"), `packages/cli/tests/cli.test.ts` ("lets go of someone removed from a private space…"), `packages/cli/tests/serve.test.ts` ("a node behind on the space key admits a reader…")._

### 6.4 The account behind a session

A handshake proves a session DID, not whose it is. So the first message each
side sends on a space's connection, as soon as the peer is admitted, is
`who` (§9.1), carrying its note: its proof. The receiver checks the note
([01 — Identity](01-identity.md) §7.5, at its own time, §7.6) and takes its
issuer as the peer's account **only if** the note is valid and its
audience is the peer's proven session DID. A list of tokens is not a note.
A proof whose canonical JSON is
longer than 16 384 characters, invalid, or made out to another key gives
the peer **no account** (`null`). Nothing else
in the note is read here; what the library tells apps about the sender is in
[the node](../packages/core/docs/node.md#live-messages-and-status).

> Rationale: a note copied off someone's record names their key, not the
> copier's, so it is useless to anyone else.

_Source: `packages/core/src/node/space-runtime.ts` (`accountOf`, `WHO_MESSAGE`). Tests: `packages/core/tests/live.test.ts` ("a peer showing someone else’s note is known as nobody")._

---

## 7. The mesh

A node holds **one socket per relay and one WebRTC connection per peer**,
however many spaces they share. Each space is a room; a connection is shared
by every room both peers are in, and a peer proves itself separately in each
room before anything of that room crosses. A peer is a peer only in the
rooms it proved itself in.

The mesh's identity is the node's session DID.

### 7.1 Frames

Every message on a mesh connection is a JSON object:

```json
{ "room": "<room>", "type": "<type>", "from": "<sender session DID>", "payload": <any> }
```

- `room` is present on every frame about a room; `__signal` frames carry
  none (a connection belongs to no one space).
- `from` is informational: a receiver MUST take the sender to be the peer
  the connection is with, never `from`.
- Reserved types (never delivered to the application): `__auth-hello`,
  `__auth-proof`, `__peers`, `__signal`, `__leave`.

| `type`         | `room` | `payload`             | Accepted from                |
| -------------- | ------ | --------------------- | ---------------------------- |
| `__auth-hello` | yes    | `{ "nonce": string }` | anyone connected             |
| `__auth-proof` | yes    | proof (§6.2)          | anyone connected             |
| `__peers`      | yes    | array of DIDs         | a peer admitted in that room |
| `__leave`      | yes    | —                     | a peer admitted in that room |
| `__signal`     | no     | relayed signal (§8)   | a peer admitted in any room  |
| anything else  | yes    | application           | a peer admitted in that room |

Any other frame from a peer is dropped.

_Source: `packages/core/src/network/mesh.ts`, `packages/core/src/network/introductions.ts`. Tests: `packages/core/tests/network-manager.test.ts`, `packages/core/tests/introductions.test.ts` ("mesh housekeeping")._

### 7.2 Admission to a room

For each `(room, peer)` a side keeps a handshake with its own fresh nonce.

- A side **greets** — sends `__auth-hello` with its nonce — when the
  connection opens and it knows the peer is in the room, or when it knows
  the peer is in the room and a connection is already open, or on receiving
  the peer's `__auth-hello` if it has not greeted yet.
- On the peer's `__auth-hello` (the first one only), it sends its
  `__auth-proof` over the peer's nonce (none in a room without proofs).
- On the peer's `__auth-proof` it checks it (§6.2); a failed check ends the
  handshake.
- The peer is **admitted** once this side has both sent its proof and
  verified the peer's (or the room asks none). Only then does anything of
  that room cross.
- A handshake not finished within **10 s** is abandoned.
- A connection that is in no room and in no handshake is closed, and so is a
  newly opened connection that no room takes up soon.

Leaving a room: a side sends `__leave` (with `room`) to each peer admitted
there, and leaves the room on the relays. A receiver of `__leave` drops the
peer from that room, and closes the connection if no room uses it.

Letting one peer go (§6.3) is the same for that peer alone: `__leave` to it,
drop it from the room, and close the connection if no room uses it. The
connection stays for the other rooms the two share.

_Source: `packages/core/src/network/mesh.ts` (`greet`, `onHandshake`, `admit`, `closeIfIdle`, `drop`). Tests: `packages/core/tests/network-manager.test.ts` ("two spaces shared by two devices use one connection", "a peer is a peer only in the rooms it shares…", "letting a peer go in one room…", "failing to prove it in one room costs nothing in another")._

### 7.3 Who connects

- **Through a relay:** a `hello` (§2) names a peer in a room. If a
  connection to it is open, the node greets it there. Otherwise, if no
  connection with it has been started and the node's DID is the lesser, it
  creates the offer and sends it through the relays (§2); it greets once the
  channel opens. The greater DID waits to be offered to.
- **Through an introduction:** see §8; the same rule, the side with the
  lexically smaller DID offers.
- **Receiving a signal** from a peer already admitted in any room is ignored:
  a proven connection is never replaced by an offer that proved nothing.
  Otherwise an `offer` is answered (replacing any unproven connection with
  that peer) and the `answer` goes back the way the offer came (relay, or
  mesh); an `answer` is applied.
- **A connection that never opens** is given up: an offer nobody answers
  leaves a connection that neither opens nor fails, and a peer already tried
  is not offered to again, so without a deadline the two stay apart until one
  restarts. A connection started by offering or answering that has not opened
  within an attempt timeout of the node's choosing is closed and forgotten,
  and the next hello from that peer starts again.

_Source: `packages/core/src/network/mesh.ts` (`meet`, `offerTo`, `onSignal`, `watch`, `meetAgain`). Tests: `packages/core/tests/network-manager.test.ts`, `packages/core/tests/relay-socket.test.ts` ("the mesh offers again")._

### 7.4 Limits

| Limit                               | Value                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Peers per room                      | 64 remembered at a time (§2); a Minca relay also holds 64 watchers a topic |
| Handshake timeout (`authTimeoutMs`) | 10 s                                                                       |
| Peers named per `__peers`           | 64 (`MAX_INTRODUCED`); the rest are ignored                                |
| Relayed-signal hops                 | 3 (`MAX_HOPS`)                                                             |

The reference node's own timers (how long an idle connection or a connection
attempt is given, how many relayed-signal ids it remembers) are in
[the node's docs](../packages/core/docs/node.md#the-network).

_Source: `packages/core/src/network/mesh.ts`, `packages/core/src/network/introductions.ts`. Tests: `packages/core/tests/introductions.test.ts`._

> **Planned:** limits on how much one peer can cost another
> ([#33](https://github.com/leifriksheim/minca/issues/33)).
>
> - **A byte rate per peer on every transport** (WebRTC, node socket), on
>   top of the per-message limits that exist for live messages (§9.2) and
>   sync ([05](05-sync-and-storage.md)). Beyond it, messages are dropped or
>   the connection closed.
> - **A cap on half-open connections from introductions**: connections
>   offered or answered because of `__peers` or `__signal` (§8) that have not
>   yet been admitted in any room. Today each is bounded only by the 10 s
>   timeouts above.
>
> Values are not chosen. Limits on the sync side (hellos and sessions per
> peer, waiting records) are in [05](05-sync-and-storage.md). Together these
> answer the open question on message size limits.

---

## 8. Introductions

Once connected to one peer, its data channel is used to arrange the next
connection, so a relay is needed only to meet the first peer in a room.
Introductions are on by default and MAY be turned off (a channel's rooms,
pairing and connecting by code, turn them off).

**`__peers`.** When a peer is admitted to a room, the admitting side sends
the newcomer `{ room, type: "__peers", payload: [every other admitted peer in
the room] }`, and each of those peers `{ room, type: "__peers", payload:
[newcomer] }`. A receiver takes at most the first 64 entries, skips anything
that is not a DID (string ≤ 256 matching `^did:key:z[1-9A-HJ-NP-Za-km-z]+$`),
and for each: if a connection to it is open, greets it in that room;
otherwise, if `ourDid < theirDid` (JavaScript string comparison, i.e. UTF-16
code units), sends it an offer through the mesh; otherwise waits for its
offer.

> Rationale: both sides are told about each other at the same moment. The
> comparison is free and both sides agree on it, so exactly one offers.

**`__signal`.** Signaling for a connection not yet open travels over the mesh:

```json
{ "type": "__signal", "from": "<sender>", "payload": {
  "id": "9f1c2a7b04d3e6aa",
  "origin": "<DID wanting to connect>",
  "target": "<DID it wants>",
  "kind": "offer" | "answer",
  "data": <RTCSessionDescriptionInit>,
  "hops": 3
} }
```

- `id` is 8 random bytes as 16 lowercase hex characters, fresh per signal.
- The sender floods it to every connected peer admitted in _any_ room.
- A receiver drops it if `id` is not a string of at most 64 characters or was
  seen before (it remembers a bounded number of recent ids), if `origin` or
  `target` is not a DID, or if `kind` is not one of the two.
- If `target` is itself, it acts on it as a signal from `origin` (§7.3) and
  replies through the mesh with new ids.
- Otherwise, if `hops > 0`, it forwards to every admitted peer except the one
  it came from, with `hops = min(hops, 3) − 1`.

_Source: `packages/core/src/network/introductions.ts`, `packages/core/src/network/mesh.ts` (`handlePeerList`, `floodSignal`, `onRelayedSignal`). Tests: `packages/core/tests/introductions.test.ts`, `packages/core/tests/network-manager.test.ts` ("a relay connects the first pair, and a peer introduces the rest")._

---

## 9. Messages on a space's connections

On every transport, a space's peers exchange messages of the form

```json
{ "type": string, "from": "<sender session DID>", "payload": <any> }
```

— on a mesh connection wrapped in the frame of §7.1 (the frame's `room`
added), on a node socket as the whole binary frame. The
receiver MUST attribute a message to the connection's peer, not to `from`.

| `type` | Payload             | Specified in                                    |
| ------ | ------------------- | ----------------------------------------------- |
| `sync` | a sync message      | [05 — Sync and storage](05-sync-and-storage.md) |
| `who`  | `{ "note": proof }` | §6.4, §9.1                                      |
| `live` | any JSON            | §9.2                                            |

A channel's rooms carry their own types (`packages/core/src/session/pairing.ts`,
`packages/core/src/session/connect-code.ts`); see [01 — Identity](01-identity.md) §15 and
[06 — Nodes, sessions and apps](06-nodes-and-sessions.md) §3. Unknown types are
ignored.

### 9.1 `who`

Sent by each side to each newly admitted peer of a space, **before any
`live` message**: `{"type":"who","from":<session DID>,"payload":{"note":<the
session's note, one token>}}`. Handling is in §6.4. A peer that sends none has no
account.

### 9.2 Live messages

A live message reaches whoever is connected in the space right now. It is
not signed as a record, not stored and not synced; a peer not connected
misses it. In a private space it reaches only peers that proved the read key,
and never a former member ([03](03-spaces.md) §9.2): a sender MUST NOT send
one to a peer whose `who` shows a former member, and a receiver MUST drop one
from such a peer.

On the wire it is `{"type":"live","from":<session DID>,"payload":<message>}`,
where `payload` is any JSON value whose `JSON.stringify` is at most 65 536
characters. It goes to a peer only after the sender's `who` (§9.1).

A receiver:

- MUST rate-limit per peer: a token bucket of **burst 60, 20 per second**;
  messages beyond it are dropped (the connection stays open);
- MUST drop a message whose `JSON.stringify(payload)` is longer than 65 536
  characters;
- attributes it to the peer's session DID, and to the account the peer's
  `who` proved (§6.4), if any.

How the library sends one, picks whom it goes to and hands one to the app is
in [the node's docs](../packages/core/docs/node.md#live-messages-and-status).

Example:

```json
{
  "type": "live",
  "from": "did:key:zDnaeV1SzGREx4fjGtUofWfZfnH42TV5EboaJ6deJLxvmo6jd",
  "payload": { "type": "typing" }
}
```

_Source: `packages/core/src/node/space-runtime.ts` (`send`, `onLive`, `withinAllowance`, `LIVE_MESSAGE`, `MAX_LIVE_BYTES`, `LIVE_BURST`, `LIVE_PER_SECOND`). Tests: `packages/core/tests/live.test.ts`._

---

## 10. ICE and TURN (client side)

A client MUST use TURN servers a relay offered (§1.4, §3) only while their
`expiresAt` is in the future. Which other ICE servers it uses, and when it
asks relays for fresh passwords, is its own choice; the reference node's is in
[the node's docs](../packages/core/docs/node.md#the-network).

_Source: `packages/core/src/network/mesh.ts` (`iceServers`). Tests: `packages/core/tests/relay-turn.test.ts` (the relay side only)._

---

## 11. Conformance summary

A compatible **Minca relay** MUST: accept sockets on any path; hand a blob
published with `ttl: 0` to the topic's other watchers and keep nothing of it;
keep a dropped blob for no longer than its `ttl` and serve it to `fetch`;
and bound sizes, rates and counts (§1.4). It SHOULD serve `/health`, and MAY
hand out TURN passwords. A **Nostr relay** is any NIP-01 relay that passes on
ephemeral events and keeps regular ones.

A compatible **client** MUST: derive rooms, topics and room keys as in §1.3;
pass over relays of kinds it doesn't speak (§1.2); watch every topic again on
reconnect; seal and check messages as in §2, acting on each `id` once; run the mesh handshake
of §6.2 in every room before sending anything of it, or the node handshake
of §6.1 on a node socket; attribute every message to the connection, not to
`from`; send `who` before `live`; and apply the receive limits of §9.2.

---

## Open questions

- **Size limits on peer connections.** No maximum WebRTC message size is
  specified or enforced; browsers' SCTP limits apply. A byte rate per peer
  is planned (§7.4).
- **"64 KB"** for live messages is measured in UTF-16 code units of the JSON
  string, not bytes.
- **Untested relay behaviour.** The rate limit, the per-address and per-topic
  caps and the heartbeat have no tests.
