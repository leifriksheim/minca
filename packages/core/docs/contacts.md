# Contacts

A contact is someone you share a private **space for two** with. Use this
page to ask someone you already share a space with to become a contact. For
someone you share no space with, use their [inbox](inbox.md).

## Asking someone

Pick a space you both belong to, and the person to ask:

```ts
const { space: pairSpace, carried } = await node.contacts.ask(space.id, did, { note: 'Hi from the co-op!' });
```

This makes a new private space for two, puts them on your list with it, and
leaves a request for them in the shared space. `space`, here `pairSpace`, is
the space for two.

`carried` is false when none of your always-on carriers held the space in
time. Then they can join only while one of your devices is online.

## Answering a request

On their side, `requests` lists what was left for them, and `accept` joins:

```ts
const [request] = await node.contacts.requests(space.id);
if (request) {
  const contact = await node.contacts.accept(space.id, request.key);
}
```

There is no reply. Joining the space for two is the answer, and you each
have the other on your list.

## The list

```ts
const contacts = await node.contacts.list();
```

`get`, `put`, `remove`, `block` and the rest are in
[`NodeContacts`](https://minca.dev/api/core/interfaces/NodeContacts/), and
each contact is a
[`ContactView`](https://minca.dev/api/core/interfaces/ContactView/). Its
`name` is what you call them. They never see it.

`remove` and `block` leave the space for two, giving up your place there,
unless another contact names the same space. `block` keeps them on the list
with `blocked: true`, and hides their requests in every space and in your
inbox. `others` lists accounts in the space for two besides the two of you,
from its members, profiles and connected peers.

A contact's `username` is what their domain answered when you found them by
it. Nothing checks it again: once a name lapses and someone else claims it,
a lookup leads to them, and your contact keeps the old one.

## Inviting a contact into a space

```ts
await node.contacts.invite(did, space.id, { role: 'member' });
```

This leaves an invite for them in your space for two. They must have joined
that space first. A request nobody has answered yet is refused, so you never
open a space to whoever a username led to before you have seen who they are.
A blocked contact is refused too.

On their side, `invites()` lists what contacts left for them, newest first,
and `join` takes them in:

```ts
const [invite] = await node.contacts.invites();
if (invite) await node.contacts.join(invite.pairSpace, invite.key);
```

Each item is a
[`SpaceInviteView`](https://minca.dev/api/core/interfaces/SpaceInviteView/).
Only invites to spaces you don't hold yet are listed. Only the contact's own
records count, and each invite is checked as joining checks it: signed by
the contact, for the space whose constitution it carries. That is where
`space` and `name` come from. Invites from someone blocked are not shown.

`invites()` also closes and deletes your own invites that the contact has
joined with.

## Who may ask

`ask` and `accept` need a session note that grants `/account/write` for the
whole account. An app granted `contacts` can see the list and the requests,
but can't ask or accept. See
[spec 06 §2.5](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## How `ask` works

1. It creates a private `team` space named `"<my name> & <their name>"`, and
   opens an `editor` invite to it.
2. It waits up to 3 seconds for an online carrier to hold the space
   (`spaces.carried`).
3. It writes a `std.contact` for them, with that space.
4. It leaves the request, a sealed knock, as a `std.contact-request`.

It returns `{ space, request, carried }`: the space for two, the request's
record key, and whether a carrier held it. It needs the other person's
`contactKey` on their profile in that space. `accept` joins the invite, and
writes a `std.contact` for the asker with the space for two.

`requests(space)` skips blocked senders, and knocks whose space for two you
already hold.

## `std.contact`

The list lives in the account's contacts space, derived with the label
`minca/contacts`, one record per person:

```
std.contact  (rules: onePer ["did"])
{ did: string ≤256, name: string ≤200, space?: string ≤256, note?: string ≤2000,
  blocked?: boolean }
record key = records.onePerKey(contactsSpace, "std.contact", { did })
           = "one:" + hex(HMAC(oneKey, "std.contact\ndid=" + canonical(did))[0..20))
             // a shared key, spec 02 §7.3: onePer without @author
```

`space` is the id of the space for two. A reader ignores a record whose key
is not the one its `did` derives. It also ignores one whose root is not the
account, as for every record in the account's derived spaces (spec 03
§13.1).

## The contact key

A request is sealed to the other person's contact key: the public half,
published as `contactKey` on their profile in the space. A node holds the
private half only when it was given it (`config.contactKey`). An agent never
is. See spec 01 §10.1 for how it is derived, and spec 03 §11 for the
profile.

## `std.contact-request`

```
std.contact-request  (no rules; who may write one is the space's grants)
{ to: <the askee's contact key, as on their profile here, ≤64>, sealed: string ≤16000 }
```

`sealed` is a knock sealed to `to`, whose invite is to the new space for two.
`ask` defines the collection first if the space lacks it, which needs
`/collection/define`. In a private space the body is sealed with the space
key too, so other members see that someone asked, not whom.

The receiver opens a request only when `to` is its own contact key, the
knock checks out, and the knock's account is the record's root and not its
own. A knock someone else copied into another record is not theirs to leave,
and opens as nothing.

The list and the request are conventions: peers that have never heard of
them sync and judge them like any other record. The knock inside is
protocol, the same however it is handed over. See
[spec 07 §6](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).

## `std.space-invite`

An invite to a space, left in a space for two: `{ space, invite }`, with
`onePer: ['space']`, so inviting again to the same space replaces it.

It stays open until its maker's node sees the contact in the space and
closes it, the next time it reads `invites()`.

Until then, a contact removed from the space can rejoin with it, as with
any open role invite ([#170](https://github.com/leifriksheim/minca/issues/170)).
Anyone else with a place in the space for two can read it
([#313](https://github.com/leifriksheim/minca/issues/313)). A view-only
invite carries the space key and can't be closed
([#172](https://github.com/leifriksheim/minca/issues/172)).

## Planned: requests that can be taken back

Today `remove` and `block` leave your request standing, so they can still
accept it, into a space nobody holds. And `spaces.leave` on a space for two
leaves the `std.contact` that names it. The plan:

- `std.contact` gains `asked?: { space: string ≤256, key: string ≤256 }`,
  where `ask` left the request.
- `remove` and `block` delete that request, when the space is still held and
  the record still stands, before leaving the space for two.
- `spaces.leave` on a space a `std.contact` names does what `remove` does.
- `ContactView` gains `waiting: boolean`, true while the other account has
  no member record in the space for two.

Tracked in [#40](https://github.com/leifriksheim/minca/issues/40).
