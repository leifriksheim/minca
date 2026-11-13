# Spaces

A space is a shared place: the records in it, and the people who may read
and write them. On this page we'll make a space, invite someone to it, and
then look at how a space decides who may do what.

## Making a space

Give it a name, say whether it is private, and pick a preset for its roles:

```ts
import { rolePresets } from '@minca/core';

const space = await node.spaces.create({
  name: 'Bike co-op',
  visibility: 'private',
  ...rolePresets.community,
});
```

A `private` space encrypts every record with the space's key, so only its
members can read it. A `public` one can be read by anyone who has it.

You are the space's founder. With no preset, the space gets `solo`: just you.

## Inviting someone

`invite` makes an invite, a string you send to someone:

```ts
const invite = await node.spaces.invite(space.id);
```

On their side, `preview` shows what it is for, and `join` takes them in:

```ts
declare const invite: string;
// ---cut---
const preview = await node.spaces.preview(invite); // its name, who sent it, the role
const joined = await node.spaces.join(invite);
```

By default the invite gives the `member` role. Pass `{ role: 'editor' }` for
another, or `{ write: false }` to let them read and not write.

An invite is long. For something to paste in a chat, ask for a short link,
about 85 characters:

```ts
const link = await node.spaces.invite(space.id, { short: true });
```

## Invite links

A private invite carries the space's key, so put it after `#` in a link.
Browsers never send that part to a server. `@minca/react` has three helpers:

- `inviteLink(invite)` makes a link to the current page.
- `inviteFromLink(text)` takes the invite out of a pasted link.
- `useInviteLink()` reads the invite the page was opened with.

## Leaving

```ts
await node.spaces.leave(space.id);
```

Anyone may leave, founders too.

## Presets

A preset is a starting constitution: who sits at the top, and the roles the
space begins with. `solo`, `team`, `community` and `coop` are described in
[Permissions](permissions.md#presets).

## Successors

A space whose constitution must change, or a headless one, moves on to a new
space, its successor:

1. Create the new space, naming the old:
   `spaces.create({ …, succeeds: oldId })`.
2. Name it in the old space: `spaces.succeed(oldId, newId)`. This needs
   `/space/succeed`, or a place in a space where no member holds it. Where
   this node holds the new space, it refuses one whose constitution doesn't
   say it succeeds the old.
3. Tell members how to join: post an invite to the new space in the old one.
   The succeed record carries only the new space's id.

A successor changes nothing in the old space. Whoever stays carries on there.

### Showing successors

`spaces.access(oldId).successors` lists every space named, with who named
it ([`SpaceAccess`](https://minca.dev/api/core/interfaces/SpaceAccess/)).
Show:

- **Every successor, in no order.** Never pick one for the member, or show
  one first. Which community to join is theirs to choose.
- **Who named each**, and whether they are still a member. A succeed stays
  after its namer is removed.
- **A successor only when both sides agree.** The new space's `succeeds`
  (`SpaceSummary.succeeds`, `preview(invite).space.succeeds`) names the old,
  and the old one's `successors` names the new. An invite to a space that
  claims to succeed another, with no succeed for it there, is a copy. Show it
  as one.

See [spec 03 §2.7](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

## Invites

`node.spaces.invite(id, options?)` takes the options in
[`InviteOptions`](https://minca.dev/api/core/interfaces/InviteOptions/): the
role it gives, `write: false` for a view-only invite, and `short` for a short
link.

### Which role

With no `role`, the invite is for `member` when you may assign it. Otherwise
it is for the first role, by name, that you may assign. With none, as in
`solo`, it is view-only.

Opening an invite for a role needs the same grant as assigning that role to
someone who holds nothing: `/role/assign` with
`{ role, self: false, roles: [] }`. Each join counts as you assigning the
role to whoever joins. So if your grant says `.self == false`, you can't join
your own invite.

Someone judged on a view from before you lost the grant still gets in. To
stop an invite, close it with `spaces.closeInvite`.

Each role invite has its own secret and its own `sys.invite` record, so you
can close one without the others.

See [spec 03 §4.5](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

### What an invite carries

An invite names where to find the space:

- the space's relays, or yours when the space names none;
- the always-on nodes that hold it, your account's hosts and the space's own,
  at most 8, each pinned by its DID. A host that doesn't answer within three
  seconds is left out, so it never holds the invite up.

On `join`, the node uses the invite's relays only when they pass
`checkRelays` and it has no relay list for the space yet. The invite's nodes
are dialled for the space, and kept like its relays.

Until the invite's record reaches this device, the space is held with
`joining: true`, and the node tries again as records arrive. See
[spec 06 §1.3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

### Previewing

`node.spaces.preview(invite)` reads an invite without storing anything, and
gives an [`InvitePreview`](https://minca.dev/api/core/interfaces/InvitePreview/).
`invitedBy` is the account that signed the invite. `preview` and `join` both
refuse an invite whose signature or note doesn't check out. See
[spec 03 §7.4](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

### Short links

`short: true` seals the invite and leaves it in two mailboxes: your account's
first host's, and the first relay's that takes it. The link names those two.
When no mailbox takes it, or the space's constitution is too big for one, you
get the long invite back. It works the same.

`preview` fetches a short link first, which is why it is async. The node
remembers it, so a preview and the join after it ask the mailboxes once. A
link whose invite is nowhere fails with "That invite was not found": it may
have expired, or its mailboxes may be down.

The device that made a link keeps its secret nowhere, so copy the link when
you make it.

See [spec 03 §7.7](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

### Short links the account keeps

Each short link's sealed invite, never its secret, is kept in the account
registry as `sys.link`. It is copied to every carrier, so your host serves it
while all your devices are away.

Every hour, and whenever the registry or a space's key changes, a device
holding the account key drops each link again where the space's members meet.
A link past its `until`, or carrying a key the space has moved on from, is
ended: its invite is closed and the record deleted.

`closeInvite` with a short link closes its invite and forgets the record.

## Keeping a space's keys and relays

The node looks after each space it opens by itself:

- It publishes this account's member key when it differs from the one
  published.
- When a key change is due, and the account may invoke `/key/change` and
  holds the current key, it changes the key. `node.spaces.changeKey` does the
  same by hand.
- In a space with no relays named yet, if the account may invoke
  `/space/relays`, it names its own.

## Flagged accounts

`spaces.access(id).flagged` lists accounts proven to have broken the
protocol's rules in the space. The proof is a warrant a member wrote and this
node checked. See [warrants](warrants.md).

## Profiles

A profile is the name and picture someone shows in a space.
`node.spaces.profiles(id)` lists them.

### Your name and picture

```ts
declare const bytes: Uint8Array;
// ---cut---
await node.account.setName('Leif');
await node.account.setAvatar({ bytes, mime: 'image/png' });
```

Both need the account key. Resize the picture first, and pass `null` to
remove it. `node.account.picture()` reads it back.

The node publishes both into every space it opens, and again when they
change. It skips the registry and the contacts space. A node whose note
lacks `/account/write`, such as an agent's, publishes nothing, and neither
does a non-member.

A picture once shared stays with the members who have it. Taking it away
shows none from then on, but withdraws nothing.

### Showing names

A name is whatever its owner typed, so two people can both be "Sam".
`displayName(did, profiles)`, or `useNames(space)` in React, adds the tail
of the identity when a name is shared. For someone with no profile it shows
the tail alone.

### How a profile is read

For each `profile:` key, the node looks at versions newest first. It skips
any that is not `sys.profile`, does not verify, does not stand, or whose
root's `hex40` is not the record key. Then:

- A deleted version ends the search: no profile.
- The first remaining version gives `name` (trimmed, cut to 64 characters;
  empty means no profile), `did` (its root) and `updatedAt` (its
  `createdAt`).
- `contactKey` comes from the newest remaining version with a valid P-256
  point, so a newer version without one does not hide it.
- `avatar` comes from the newest version only, so a version without it takes
  it away. It is a file reference (`records.addFile`) whose `mime` is an
  image.

### How a profile is written

Profiles are written with `retain`, so older versions stay. A writer that
does not hold the contact key must carry forward the `contactKey` of its
current profile.

The account keeps its own name in the account registry, as `sys.profile` at
key `profile`, with body `{ name, avatar? }`. The newest version wins.

Members of a space can't read the registry, so the picture is copied into
each space once, as a file of that space. Its reference names the registry
file it copies (`source`), so opening the space again makes no second copy. A
picture that can't be copied now, because its bytes are on a device that is
away, leaves the space's copy as it was. It never holds back the name.

The record format, and whose versions count, are protocol. See
[spec 03 §11](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)
and [spec 06 §1.3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

> **Planned:** profiles, round two. A name per space ("in this space, call
> me…"), which the next rename of the account would not overwrite. And
> private nicknames for others, kept in the account's own spaces, as
> `std.contact`'s `name` already does for contacts. Open: the field names, the
> avatar's size limit and format, a collection for nicknames of non-contacts,
> and whether `profile:` keys change (spec 03 §8.6).

## The space manager

The space manager keeps what the node knows about each space in its
`registry` store, sealed at rest (see [node](node.md#stores)):

| Storage key           | Value                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `space:<id>`          | JSON space object                                                                            |
| `spacekey:<id>`       | JSON `{ keys: [{ id, raw, createdAt, version }], current }`: every key held, `raw` base64url |
| `spaceinvite:<id>`    | base64url invite secret, until used                                                          |
| `spacerole:<id>`      | `founder`, or a role last held: a hint for listing, never a gate                             |
| `spacememberkey:<id>` | base64url member key scalar, for a node given it without the account key                     |
| `spacerelays:<id>`    | JSON relay list last heard                                                                   |

`remove` deletes all six. Joining again with a secret while one is waiting
keeps the newer one.

## The account's own automations

What the account wants to hear about is an automation of its own, kept in
its registry. See [automations](automations.md#the-accounts-own). Its `app`
names the app that proposed it, and that app shows what it matches. A home
adds none of its own.

### Narrowing with `where`

A proposal, or an app's `notify` entry, can carry a `where`: a filter over
the record, the same as a [query's](query-format.md). It can test body
fields, `link:<rel>`, `@key`, `@collection`, `@createdBy` and `@createdAt`.
Build one from what a person picks, "a task whose priority is at least 3",
rather than offering a fixed list:

```typescript
import { notifyOn } from '@minca/core/schemas';

await connection.propose([
  notifyOn('Urgent task for me', 'std.task', {
    assignees: { $contains: '$me' },
    priority: { $gte: 3 },
  }),
]);
```

`checkOwnAutomation` says whether one can be kept. `matches(record, filter)`
says whether a filter holds, so you can show what it would have matched
before proposing it.
