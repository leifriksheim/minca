# The inbox

An account's inbox is an address it hands out on purpose, so that someone it
shares no space with can ask to become a contact. The keys, the inbox code, the
topic, the relay mailbox and the sealed knock are protocol
([spec 07](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md)):
a relay and the inbox's owner check them.

What this page covers is a convention built on them, not part of the protocol:
where an account keeps its inbox's settings, and how a knock becomes a space
for two and a contact. Peers that have never heard of `std.inbox` or
`std.knock` sync, store and judge them like any other record. Only the devices
of one account have to agree on what follows.

## `std.inbox`

The inbox's settings are a `std.inbox` record in the account's **contacts
space** ([spec 03](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)),
which only the account can find and every one of its devices holds.

| Field    | Type                 |                                                                                                                             |
| -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gen`    | integer ≥ 0          | Which inbox: both keys are derived from it ([spec 07 §1](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md)) |
| `places` | string[], 1–3        | Mailbox URLs, each passing the inbox code's relay check                                                                     |
| `name`   | string ≤64, optional | The name the code gives whoever knocks                                                                                      |

A device treats as the inbox only a verified `std.inbox` whose root is the
account itself, and of those the one with the highest `gen`, then the newest.
Changing the places or the name writes the next version of that record: the
keys stay, so a code already handed out keeps working once it is read again.
**Replacing** the inbox (`rotate`) clears what waits in the old one and writes
`gen + 1`: the old code leads to a topic nobody reads, and nothing ties the
new keys to the old.

_Source: `packages/core/src/schemas/contacts.ts` (`inbox`), `packages/core/src/node/node-contacts.ts` (`inboxRecord`, `writeInbox`, `inbox.rotate`). Tests: `packages/core/tests/inbox.test.ts` ("node.inbox")._

## The exchange

```
 Anna                                 mailbox(es)                                  Leif
  │ inbox.open() → std.inbox, code                                                 │
  │ ── code, out of band (a link, a QR code, a bio) ─────────────────────────────▶ │
  │                                          spaces.create(private), invite(editor) │
  │                                          spaces.carried: a carrier holds it     │
  │                                    ◀── drop(topic, sealed knock) ── to each    │
  │                                                     std.knock { space, invite } │
  │ fetch(topic) ──▶ ◀── mail [knock]                                              │
  │ open + check (spec 07 §6)                                                      │
  │ accept: spaces.join(invite); std.contact { did: Leif, space }                  │
  │         purge(knock) ──▶                                                       │
  │ ═════════════════ the space for two syncs, through Leif's carrier if he's away ▶ │
  │                       Anna is a member: std.contact { did: Anna }, invite       │
  │                                                closed, std.knock deleted        │
```

**Knocking.** The knocker:

1. reads the code and checks its signature, and refuses its own inbox;
2. creates a private space named `"<own name> & <code name>"` with the `team`
   role preset, and makes an editor invite;
3. if one of the account's carriers is online, waits up to 3 seconds for it to hold the
   space and its invite (`spaces.carried`), so the other person can join with
   every device of the knocker's away. With no carrier, or none in time, it
   goes on and says so: `knock` returns `carried: false`;
4. seals the knock ([spec 07 §6](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md))
   and drops it in **every** mailbox the code names, since any one of them may
   lose it (the reference relay keeps its mailbox in memory, so a restart
   loses what it held);
5. if no mailbox answers `dropped`, leaves the space and fails;
6. otherwise writes `std.knock { space, name, invite }` in its contacts space.

**Opening.** Besides the checks the protocol requires, the owner's devices
skip knocks from the account itself, from accounts its contact list marks
blocked, and whose space for two it already holds (accepted here or on
another device).

**Accepting.** The owner joins the invite and writes
`std.contact { did: <the knocker's account>, name, space }`, keeping a name it
already had for that account, and purges the knock from the mailboxes. There
is no answer record: joining is the answer.

**Settling.** For each `std.knock`, the knocker's devices look at the members
of its space for two. The first account other than its own that holds a place
there is whoever answered: only the holder of the inbox key could open the
invite. They write
`std.contact { did: <that account>, name: <their profile name, else the code's>, space }`,
close the invite, and delete the `std.knock`, so nobody joins after. Anyone
else who joined too shows up in `contacts.others`.

The invite is multi-use until then, so it must reach nobody else: if the
owner passes it on, or a device of theirs is lost before they accept, whoever
joins first is taken for them. The old door answer, signed with a key of the
door's, ruled that out; it cost a second record and a signing key, and the
person accepting can as well forward the knock itself.

A `std.knock` nobody joined within the knock TTL (14 days) plus a day is let
go: the knocker leaves the space and deletes the record. One whose space is no
longer held is deleted.

**Dismissing** a knock purges it from the mailboxes; nothing else is written,
and the knocker is not blocked. **Clearing** the inbox purges all of its
knocks and keeps it open.

| Collection  | Fields                                                   | Rules               | Where                    |
| ----------- | -------------------------------------------------------- | ------------------- | ------------------------ |
| `std.inbox` | `gen` ≥ 0 and `places` (1–3) required; `name` ≤64        | —                   | Owner's contacts space   |
| `std.knock` | `space` ≤256, `name` ≤64, `invite` ≤12000 (all required) | `onePer: ['space']` | Knocker's contacts space |

**Who may.** Knocking and accepting create or join a space, so they need a note
that grants `/account/write` for the whole account, as `contacts.ask` does,
and the contact key. The inbox is the person's: a node whose note lacks
`/account/write`, such as an agent's, refuses to open, replace, clear, read,
knock, accept or dismiss. A home never gives an agent the contact key in the
first place ([spec 06 §2.8](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/node/node-contacts.ts` (`makePair`, `settleSent`, `readKnocks`, `inbox`), `packages/core/src/node/types.ts` (`NodeInbox`), `packages/core/src/schemas/contacts.ts` (`inbox`, `knock`), `packages/core/src/inbox/inbox.ts`, `packages/core/src/session/auth.ts` (`grant`). Tests: `packages/core/tests/inbox.test.ts` ("node.inbox"), `packages/core/tests/carrier.test.ts` ("a space made just now, carried before its invite goes out…"), `packages/core/tests/records-only.test.ts`._

## `node.inbox`

The calls are listed with the rest of the node, in [node.md](node.md#the-inbox).
`node.inbox.knocks()` fetches; it doesn't watch, though the mailbox supports
`watch`. The default mailbox client opens a fresh WebSocket to a relay for
each call.

_Source: `packages/core/src/network/relays.ts` (`createMailboxClient`)._

## Not yet built

- **Live knocks.** Watching the inbox's topic, so a knock shows as it arrives.
- **Retrying a knock** that reached no mailbox, or whose mailboxes lost it
  (restart), until someone joins or it expires. A retry is a fresh knock,
  signed and dropped at once.
- **Mailboxes that last.** A host that keeps its accounts' inbox topics
  across restarts, as it keeps short links.

## Planned: names

The protocol side of names (a handle resolving to an inbox code) is planned in
[spec 07 §9](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).
On this side:

- `node.inbox.knock` accepts a handle wherever it takes a code.
- **Who may knock.** The inbox gains a policy in its `std.inbox` record (never
  published): `anyone` (default), `follows` or `mutuals` on the handle's
  network. Knocks that don't match are kept but shown apart.
