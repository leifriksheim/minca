# Contacts

A contact is someone you share a **private space for two** with. The account
keeps its list of them in its contacts space, and asks someone to become a
contact by leaving a knock for them: in a space both belong to, or in their
inbox.

The list and the request are conventions built on the protocol, not part of
it. Peers that have never heard of `std.contact` or `std.contact-request`
sync, store and judge them like any other record. The knock they carry is
protocol: how it is signed and sealed, and what the person it is for checks,
is [spec 07 §6](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md),
the same however it is handed over.
Asking someone you share **no** space with goes through their inbox
([inbox.md](inbox.md)).

## The list: `std.contact`

The list lives in the account's contacts space (derived with the label
`minca/contacts`), one record per person:

```
std.contact  (rules: onePer ["did"])
{ did: string ≤256, name: string ≤200, space?: string ≤256, note?: string ≤2000,
  blocked?: boolean }
record key = records.onePerKey(contactsSpace, "std.contact", { did })
           = "one:" + hex(HMAC(oneKey, "std.contact\ndid=" + canonical(did))[0..20))
             // a shared key, spec 02 §7.3: onePer without @author
```

`name` is what you call them; they never see it. `space` is the id of the
space for two. `blocked` hides that person's knocks, in every space and in the
inbox.

A reader must ignore a record whose key is not the one its `did` derives. It
also ignores one whose root is not the account, as it does for every record in
the account's derived spaces (spec 03 §13.1).

## The contact key

A knock left in a shared space is sealed to the askee's contact key: the
public half, published as `contactKey` on their profile in the space (spec 03
§11). How it is derived is in spec 01 §10.1. A node holds the private half
only when it was given it (`config.contactKey`); an agent never is.

## Asking in a shared space

```
std.contact-request  (no rules; who may write one is the space's grants)
{ to: <the askee's contact key, as on their profile here, ≤64>, sealed: string ≤16000 }
```

`ask` leaves one in the space: `sealed` is a knock sealed to `to` (spec 07
§6), whose invite is to a new space for two. It defines the collection first
if the space lacks it, which needs `/collection/define`. In a private space
the body is sealed with the space key too, so other members see that someone
asked, not whom.

The receiver opens a request only when `to` is its own contact key, the
knock checks out (spec 07 §6), and the knock's account is the record's root
and not its own. A knock copied into another record by someone else is not
theirs to leave, and opens as nothing.

## `node.contacts`

- `space()`: the contacts space's id, or null for a node not given it.
- `list()`, `get(did)`: the list, blocked people too, by name.
- `put({ did, name, space?, note? })`: adds someone, or changes what the list
  says about them.
- `ask(space, did, { note? })` needs whole-account access and the askee's
  `contactKey` on their profile in that space. It creates a private `team`
  space named `"<my name> & <their name>"`, opens an `editor` invite to it,
  waits up to 3 seconds for a carrier that is online to hold it (`spaces.carried`), writes a
  `std.contact` for them with that space, then leaves the knock as
  `std.contact-request`. It returns the space for two, the record's key, and `carried`:
  false when no carrier held the space in time, so the askee can join only
  while one of the asker's devices is online.
- `requests(space)` lists the knocks left there that open for this account,
  skipping blocked senders and knocks whose space for two the account already
  holds.
- `accept(space, requestKey)` joins the invite (spec 03 §7.6) and writes a
  `std.contact` for the asker with the space for two. There is no reply
  record: joining is the answer.
- `remove(did)` leaves the space for two (spec 03 §6.2), giving up the
  account's place there, unless another contact names it, and deletes the
  `std.contact`.
- `block(did)` leaves the space for two likewise and writes the contact with
  `blocked: true`.
- `others(did)` lists accounts other than the two seen in the space for two
  (members, profiles, connected peers).

`ask` and `accept` need a session note that grants `/account/write` for the
whole account, as a knock does. An app granted `contacts` sees the list and
requests, but may not ask or accept
([spec 06 §2.5](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/schemas/contacts.ts` (`contact`), `packages/core/src/identity/contact-key.ts` (`deriveContactKeyBytes`), `packages/core/src/inbox/inbox.ts` (`sealKnock`, `openKnock`), `packages/core/src/node/node-contacts.ts` (`openMail`, `makePair`, `contacts`), `packages/core/src/schemas/contacts.ts` (`contactRequest`), `packages/core/src/node/types.ts` (`NodeContacts`), `packages/core/src/space/account-registry.ts` (`deriveContactsSpace`). Tests: `packages/core/tests/contacts.test.ts`, `packages/core/tests/attacks.test.ts` ("a knock re-posted by someone else…")._

## Planned: requests that can be taken back

A list that never names a space the account left, and requests that can be
taken back. Today the `std.contact` does not record where `ask` left the
knock, so `remove` and `block` leave it standing: the askee can still accept
it, into a space nobody holds. And `spaces.leave` on a space for two leaves the
`std.contact` naming it.

- `std.contact` gains `asked?: { space: string ≤256, key: string ≤256 }`, the
  space and record key of the request. `ask` writes it.
- `remove(did)` and `block(did)` delete the request at `asked` when the
  space is still held and the record still stands, before leaving the space
  for two.
- `spaces.leave(id)` on a space a `std.contact` names does what `remove` does
  for that contact.
- `ContactView` gains `waiting: boolean`, true while the other account has no
  member record in the space for two.

Tracked in [#40](https://github.com/leifriksheim/minca/issues/40).
