# The inbox

An inbox is an address you hand out on purpose, so that someone you share no
space with can ask to become your contact. They knock, you accept, and you
both end up in a private space for two.

## Opening your inbox

```ts
const inbox = await node.inbox.open();
```

`inbox.code` is what you hand out: in a link (`#inbox=…`), a QR code or a
bio. Or claim a [username](usernames.md), so people can find you by a name
they can say aloud.

## Knocking

On the other side, knock with the code, a link with it, or a username:

```ts
declare const code: string;
// ---cut---
const { space, carried } = await node.inbox.knock(code, { note: 'We met at the meetup' });
```

`space` is the new space for two. `carried` is false when none of your
always-on carriers held it in time, so they can join only while one of your
devices is online.

`node.inbox.sent()` lists your knocks nobody has joined yet. Once they join,
they become a contact on your side by themselves.

## Answering knocks

```ts
const [knock] = await node.inbox.knocks();
if (knock) {
  const contact = await node.inbox.accept(knock.id);
}
```

`accept` joins the space for two and puts them on your list. There is no
reply: joining is the answer. `dismiss(id)` lets a knock go, without
blocking whoever knocked.

`knocks()` fetches what is waiting. It doesn't watch, though the mailbox
could. The default mailbox client opens a fresh WebSocket to a relay for each
call. Every call is listed in [node.md](node.md#the-inbox).

## Changing your inbox

Call `open` again to change where knocks wait (1 to 3 mailboxes) or the name
the code gives:

```ts
await node.inbox.open({ name: 'Leif', places: ['wss://relay.minca.social'] });
```

The keys stay the same, so a code you already handed out keeps working.

`rotate()` replaces the inbox. It clears what waits in the old one, and the
old code leads nowhere. Nothing ties the new inbox to the old.

`clear()` purges every waiting knock and keeps the inbox open.

## Who may

Knocking and accepting create or join a space, so they need a note that
grants `/account/write` for the whole account, as `contacts.ask` does, and
the contact key.

The inbox is the person's. A node whose note lacks `/account/write`, such as
an agent's, refuses to open, replace, clear, read, knock, accept or dismiss.
A home never gives an agent the contact key in the first place. See
[spec 06 §2.8](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## The exchange

Here is what happens when Leif knocks on Anna's inbox:

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

### Knocking

The knocker:

1. Reads the code, checks its signature, and refuses its own inbox.
2. Creates a private space named `"<own name> & <code name>"` with the
   `team` preset, and makes an editor invite.
3. If one of its carriers is online, waits up to 3 seconds for it to hold the
   space and invite (`spaces.carried`). With no carrier, or none in time, it
   goes on and returns `carried: false`.
4. Seals the knock and drops it in **every** mailbox the code names. Any one
   of them may lose it: the reference relay keeps its mailbox in memory, so a
   restart loses it.
5. If no mailbox answers `dropped`, leaves the space and fails.
6. Otherwise writes `std.knock { space, name, invite }` in its contacts
   space.

### Opening

Besides the checks the protocol requires, the owner's devices skip knocks
from the account itself, from anyone blocked on its contact list, and whose
space for two it already holds, accepted here or on another device.

### Accepting

The owner joins the invite and writes
`std.contact { did: <the knocker's account>, name, space }`. It keeps a name
it already had for that account. Then it purges the knock from the
mailboxes.

### Settling

For each `std.knock`, the knocker's devices look at the members of its space
for two. The first other account with a place there is whoever answered,
since only the holder of the inbox key could open the invite. They write
`std.contact { did: <that account>, name: <their profile name, else the code's>, space }`,
close the invite, and delete the `std.knock`, so nobody joins after. Anyone
else who joined too shows up in `contacts.others`.

The invite works for anyone until then, so it must reach nobody else. If the
owner passes it on, or loses a device before accepting, whoever joins first
is taken for them. The owner could just as well forward the knock itself.

### Expiry

A `std.knock` nobody joined within the knock TTL (14 days) plus a day is let
go: the knocker leaves the space and deletes the record. One whose space is
no longer held is deleted.

The keys, the inbox code, the topic, the mailbox and the sealed knock are
protocol. See [spec 07](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).

## `std.inbox`

The inbox's settings are a `std.inbox` record in the account's contacts
space, which only the account can find and every one of its devices holds.
The knocker keeps a `std.knock` in its own.

| Collection  | Fields                                                   | Rules               | Where                    |
| ----------- | -------------------------------------------------------- | ------------------- | ------------------------ |
| `std.inbox` | `gen` ≥ 0 and `places` (1–3) required; `name` ≤64        | —                   | Owner's contacts space   |
| `std.knock` | `space` ≤256, `name` ≤64, `invite` ≤12000 (all required) | `onePer: ['space']` | Knocker's contacts space |

- `gen` says which inbox: both keys are derived from it.
- `places` are mailbox URLs, each passing the inbox code's relay check.
- `name` is the name the code gives whoever knocks.

A device takes as the inbox only a verified `std.inbox` whose root is the
account itself, and of those the one with the highest `gen`, then the newest.
Changing the places or the name writes a new version of that record. `rotate`
writes `gen + 1`.

These records are conventions: peers that have never heard of them sync and
judge them like any other record. Only one account's devices need to agree
on them. See
[spec 07 §1](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).

## Not yet built

- **Live knocks:** watching the inbox's topic, so a knock shows as it
  arrives.
- **Retrying a knock** that reached no mailbox, or whose mailboxes lost it,
  until someone joins or it expires. A retry is a fresh knock, signed and
  dropped at once.
- **Mailboxes that last:** a host that keeps its accounts' inbox topics
  across restarts, as it keeps short links.
