# Spaces in the library

What the library chooses when it creates, invites to, reads and keeps
spaces: constitution templates, invite defaults, profiles, the space manager, and how
an app shows the account's own automations.

> Not protocol. None of this is checked by a peer, and another implementation
> may do it differently and still interoperate. What peers must agree on about
> spaces is in [spec 03 — Spaces](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

## Presets

A preset is a constitution template: who sits at the top, the roles a space
is founded with and the grants each holds, and the roles the creator starts
with ([spec 03 §1–§2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
The protocol reads whatever a constitution names and never looks at a
preset's name; these are a sensible start for an app. Spread one into
`spaces.create`, change it, or write your own:

```ts
await node.spaces.create({ name: 'Bike co-op', visibility: 'private', ...rolePresets.coop });
```

| Preset      | `top`      | Roles and their grants                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solo`      | `founders` | none: the founder alone                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `team`      | `founders` | editor: `/record`; `/collection/define`; `/role/assign` with `.role == "editor"`                                                                                                                                                                                                                                                                                                                                                                               |
| `community` | `founders` | admin: `/record`, `/collection/define`, `/role/assign`, `/role/define` for every role but admin, `/role/unassign` and `/member/remove` of anyone not an admin, `/std.automation/instruct`, `/space/succeed`, `/key/change`, `/space/relays`, `/space/keepers`; moderator: `/record`, `/role/assign` with `.role == "member"`, `/std.automation/instruct`; member: `/record/write` and `/record/delete` where `.byCreator` is true, outside `STAFF_COLLECTIONS` |
| `coop`      | `none`     | steward (the creator's): `/record`, `/collection/define`, `/role/define` for member, `/role/assign` and `/role/unassign` of member or steward, `/member/remove` of anyone, `/std.automation/instruct`, `/space/succeed`, `/key/change`, `/space/relays`, `/space/keepers`; member: as in `community`, and `/space/succeed`                                                                                                                                     |

Under `top: founders` the creator is the space's founder and holds every
command whatever the roles say, so no `founders` preset needs a role for it.
`cofounders` names others who found it too. Under `top: none` (`coop`) there
is no founder: the creator holds only `creatorRoles`, here `steward`, and
another steward can remove it.

Each preset must say explicitly whether members may change each other's
records: a grant of `/record/write` without a policy on `.byCreator` lets
them. In `community` and `coop`, members change only what they made, and
moderators or stewards anything.

What `.roles` protects, and what it doesn't. "Of anyone not an admin" is a
policy on the target's roles, read as of the remover's own view, which the
remover chooses by what it names as seen (spec 03 §2.3, §3.2). It stops an
admin who has seen another's promotion. It doesn't stop one who names a view
from before it, or acts concurrently with it: `community` admins can still
remove or demote each other that way. `.roles` protects only against a
remover whose view includes the target's role. A space where that matters
gives removal to fewer people, or to the founders alone.

A role that may define itself can be locked by rival definitions (spec 03
§2): two of its holders who rewrite it apart and disagree leave it holding
only what they share, and if that drops `/role/define`, nobody in it can
settle them. So a preset gives `/role/define` for a role to another role, or
to the founders alone: in `community` the founders define admin, and admins
define the rest. In `coop` stewards define member, and nobody defines
steward: its grants are the constitution's, and changing them takes a
successor.

`STAFF_COLLECTIONS` are the standard collections only moderators start in a
community: announcements, badges, awards, pins, labels, channels and hosts.
Their definitions used to say so with `create` rules; now the template does.

When a space is created with no roles, it gets `solo`. The account's derived
spaces (the registry, the contacts space) use `solo`'s roles, none, byte for
byte: their ids depend on it
([spec 03 §13.1](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
Changing `solo` would change those ids, so it must not change.

_Source: `packages/core/src/space/presets.ts` (`solo`, `team`, `community`, `coop`, `STAFF_COLLECTIONS`), `packages/core/src/space/grants.ts`, `packages/core/src/space/space-manager.ts` (`create`), `packages/core/src/node/node.ts` (`spaces.create`). Tests: `packages/core/tests/space.test.ts`, `packages/core/tests/roles.test.ts` ("definitions", "`community` admins can remove each other by naming a view before the promotion"), `packages/core/tests/constitution.test.ts` ("the templates are well formed", "a co-op: no founders…")._

## The top and founders

`spaces.access(id)` says who is at the top: `top` (`founders` or `none`),
each member's `founder`, and `founder` for this account. A founder may:

- **step down** with `spaces.stepDown(id, { keep? })`: it stays, with the
  roles it holds, and is a founder no more. Given `keep`, it assigns itself
  that role first. With no role it would be no member, so the library
  refuses; to go altogether, `leave`. Stepping down strikes whatever this
  account did elsewhere that hadn't seen it, as leaving does, so do it from
  a device that has synced;
- **leave**, with `spaces.leave(id)`, as anyone may.

Nobody removes or demotes a founder but the founder itself, so an app shows
no remove button on a founder, and a "Step down" button on your own row when
you are one.

**Headless.** `access.headless` is true when no founder is left and no
member may define or assign any role. Members keep what their roles allow,
but nobody can change roles, and nothing in the constitution can change. An
app says so plainly ("No one can change roles here any more") and offers the
way on: naming a successor (below), which any member may do once no member holds `/space/succeed`.

_Source: `packages/core/src/node/space-runtime.ts` (`stepDown`, `access`), `packages/core/src/space/roles.ts` (`headless`). Tests: `packages/core/tests/constitution.test.ts` ("stepping down", "a founder steps down, keeping a role…")._

## Successors

A space whose constitution must change, or a headless one, moves on to a
successor (spec 03 §2.7). With the library:

1. Create the new space naming the old: `spaces.create({ …, succeeds: oldId })`.
2. Name it in the old space: `spaces.succeed(oldId, newId)`. It needs
   `/space/succeed`, or a place in a space where no member holds it. Where
   this node holds the new space, it refuses one whose constitution doesn't
   say it succeeds the old.
3. Tell members how to join it: an invite to the new space, posted in the
   old one (an announcement, a message). The succeed record carries only the
   new space's id.

`spaces.access(oldId).successors` lists every space named, each with the
accounts that named it: `[{ space, by }]`. A successor changes nothing in
the old space; whoever stays carries on there.

What an app shows:

- every successor named, **in no order**: never one as first, and never one
  picked for the member, since which community a member joins is theirs to
  choose. The list's order means nothing;
- who named each, and whether each namer is still a member: a succeed stays
  named after its namer is removed;
- that a space is a successor only once both hold: the new space's
  `succeeds` (`SpaceSummary.succeeds`, `preview(invite).space.succeeds`)
  names the old one, and the old one's `successors` names the new. An
  invite to a space that claims to succeed another, with no succeed for it
  there, is a copy, and is shown as one.

_Source: `packages/core/src/node/node.ts` (`spaces.succeed`), `packages/core/src/node/space-runtime.ts` (`succeed`, `access`), `packages/core/src/space/space-manager.ts` (`previewInvite`). Tests: `packages/core/tests/constitution.test.ts` ("/space/succeed", "a successor: made with succeeds…")._

## Invites

`node.spaces.invite(id, options?)`:

- With no role given, it opens an invite for `member` when the inviter may
  assign it (`/role/assign` with `{ role, self: false, roles: [] }`), else for
  the first role by name it may assign. With none (as in `solo`), it makes a
  view-only invite. Opening an invite for a role needs the same grant as
  assigning it to someone holding nothing. Peers judge each join as the
  assignment the invite's opener makes, to whoever joins (spec 03 §4.5): an
  opener whose grant says `.self == false` can't join its own invite. A
  joiner judged in a view from before the opener lost the grant still gets
  in: to stop an invite, close it.
- `write: false` always makes a view-only invite.
- Each role invite gets its own fresh secret and its own `sys.invite` record,
  so one can be closed without the others.
- The invite names the space's relays, or the inviter's own when the space
  names none, and the always-on nodes that hold it: the account's hosts and
  the space's own, at most 8, each pinned by its DID. A host that can't be
  described within three seconds is left out rather than hold the invite up.
- `short: true` makes a short link (spec 03 §7.7), about 85 characters: the
  invite is sealed and left in the mailbox of the account's first host and of
  the first relay that takes it, and the link names those two. Where no
  mailbox takes it, or the space's constitution is too large for one, the
  long invite is returned instead; it works the same. `until` (ms) says when
  to stop sharing it.

**Short links the account keeps.** Each short link's sealed invite is kept in
the account registry (`sys.link`), never its secret, and copied to every
carrier's carry space, so the account's host serves it while every device is
away. Every hour, and whenever the registry or a space's key changes, a
device holding the account key drops each one again where the space's members
meet. One past its `until`, or carrying a key the space has moved on from, is
ended: its role invite is closed and the record deleted. `closeInvite` by a
short link closes its invite and forgets the record. The device that made a
link holds its secret nowhere: copy the link when it is made.

`node.spaces.preview(invite)` reads an invite without storing anything, and
for a short link fetches it first, which is why it is async:

```
{ space: { id, name, visibility, founders, createdAt, succeeds? }, invitedBy,
  carriesKey, carriesWrite, role,       // role is null for a view-only invite
  until? }                              // a short link's, when given
```

`invitedBy` is the account that signed the invitation: `preview` and `join`
both refuse an invite whose signature or note doesn't check out ([spec 03 §7.4](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
A short link is fetched once and remembered by the node, so a preview and the
join after it ask the mailboxes once. A link whose invite is nowhere fails
with "That invite was not found"; it may have expired or its places be down.
Invite nodes are dialled for the space alongside the hosts the account uses,
and kept like its invite relays.

On `join`, relays carried by the invite are a hint: the node uses them only
when they pass `checkRelays` and it holds no relay list for the space yet.
While the invite's record has not reached this device, the space is held with
`joining: true` and the node tries again as records arrive
([spec 06 §1.3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/node/node.ts` (`spaces.invite`, `preview`, `join`, `nodesOf`, `shortInvite`, `resolveInvite`, `keepLinks`), `packages/core/src/space/space-manager.ts` (`previewInvite`, `join`), `packages/core/src/space/invite-link.ts`. Tests: `packages/core/tests/space.test.ts` ("invites"), `packages/core/tests/roles.test.ts` ("invites"), `packages/core/tests/invite-link.test.ts`, `packages/cli/tests/host.test.ts` ("someone invited reaches the space through the inviter’s host…", "a short link: the host keeps it…")._

## Keeping a space's keys and relays

The node does the protocol's key upkeep by itself, in each space it opens:

- On every upkeep it publishes this account's member key when it differs from
  the one published.
- When a key change is due and its account may invoke `/key/change` and it
  holds the current key, it changes the key. `node.spaces.changeKey` does the
  same by hand.
- In a space with no relays named yet, a node whose account may invoke
  `/space/relays` names its own.

_Source: `packages/core/src/node/space-runtime.ts` (`upkeep`, `rotateKey`, `nameRelays`). Tests: `packages/core/tests/key-change.test.ts`, `packages/core/tests/space-relays.test.ts`._

## Flagged accounts

`spaces.access(id).flagged` lists accounts proven to have broken the protocol's
rules in the space, by warrants members wrote and this node checked
([warrants](warrants.md)).

## Profiles

The record format, and whose versions count, is protocol
([spec 03 §11](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)).
The rest is the library's.

**Reading.** For each `profile:` key, the node looks at versions newest first,
skipping any that is not `sys.profile`, does not verify, does not stand, or
whose root's `hex40` is not the record key:

- a deleted version ends the search: no profile;
- the first remaining version gives `name` (trimmed, cut to 64 characters;
  empty means no profile), `did` (its root) and `updatedAt` (its `createdAt`);
- `contactKey` comes from the newest remaining version that carries a valid
  P-256 point, so a newer version written without one does not hide it.
- `avatar` comes from the newest version only (one without it has taken it
  away): a file reference (`records.addFile`) whose `mime` is an image.

**Writing.** Profiles are written with `retain`, so older versions stay. A
writer that does not hold the contact key must carry forward the
`contactKey` of its current profile.

**The account's name and picture.** The account keeps its name in the
account registry, as `sys.profile` at key `profile` with body
`{ name, avatar? }`; the newest version wins. `node.account.setName` writes
the name, `setAvatar({ bytes, mime })` the picture (a file in the registry;
the app resizes it first), and `picture()` reads it back. The node publishes
both into every space it opens, and again on a change. A space's members
can't read the registry, so the picture is copied into each space once, as a
file of that space, and its reference names the registry file it copies
(`source`), so opening the space again makes no second copy. A picture that
can't be copied now (its bytes on a device that is away) leaves the space's
copy as it was, and never holds back the name. Profiles are retained, so a
picture once shared stays with the members who hold it: taking it away
shows none from then on, and withdraws nothing. It publishes
in every space but the registry and the contacts space, and not at all from
a node whose note lacks `/account/write` (an agent's); a non-member
publishes nothing
([spec 06 §1.3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

> **Planned:** profiles, round two.
>
> - **A name per space** ("in this space, call me…"). The record is already
>   per space; what is missing is a way to say the name was chosen for this
>   space, so publishing the account name on the next rename does not
>   overwrite it.
> - **Private nicknames for others**: a name you give someone, seen only by
>   you. It belongs in the account's own spaces, not in the shared one;
>   `std.contact`'s `name` already does this for contacts.
>
> Open questions: the field names; the avatar's size limit and format; and
> whether nicknames for people who are not contacts get a collection of their
> own. `profile:` keys may also change (spec 03 §8.6).

_Source: `packages/core/src/node/space-runtime.ts` (`loadProfiles`, `publishProfile`), `packages/core/src/node/node.ts` (`publishProfile`, `ownName`, `account.setName`), `packages/core/src/space/account-registry.ts` (`PROFILE_COLLECTION`, `PROFILE_KEY`). Tests: `packages/core/tests/profiles.test.ts`, `packages/core/tests/contacts.test.ts` ("the contact key"), `packages/core/tests/account.test.ts` ("the account name")._

## The space manager

The space manager keeps, per space, in a storage adapter (the node's
`registry` store, sealed at rest; see [node](node.md#stores)):

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

_Source: `packages/core/src/space/space-manager.ts`. Tests: `packages/core/tests/space.test.ts` ("space manager")._

## The account's own automations

What the account wants to hear about is an automation of its own, kept in
its registry ([automations](automations.md#the-accounts-own)). Its `app`
names the app that proposed it, and that app shows what it matches. A home
adds none of its own.

**Narrowing with `where`.** A proposal, and an app's `notify` entry, may
carry a `where` in its query: a filter over the record, the same as a
query's ([query-format.md](query-format.md)): body fields, `link:<rel>`, and
of the record's own fields `@key`, `@collection`, `@createdBy` and
`@createdAt`. An app can build one from what a person picks — "a task whose
priority is at least 3", "a poll that isn't closed" — rather than offering a
fixed list. `checkOwnAutomation` says whether one can be kept, and
`matches(record, filter)` whether it holds, which an app can use to show
what it would have matched before proposing it.

```typescript
await connection.propose([
  notifyOn('Urgent task for me', 'std.task', {
    assignees: { $contains: '$me' },
    priority: { $gte: 3 },
  }),
]);
```

A condition on a topic field, at the top of `where` or in an `$and` there,
is what a carrier's wake matches; the rest is judged only by the app. Without
one, a carrier wakes the app for every new record of the collection, and the
app turns down the rest.

_Source: `packages/core/src/space/own-automations.ts` (`checkOwnAutomation`, `notifyOn`, `matchesRecord`), `packages/core/src/query/filter.ts` (`checkFilter`, `matches`), `packages/core/src/node/node.ts` (`automations`), `apps/example/src/notifications.ts`. Tests: `packages/core/tests/carrier.test.ts` ("notifications through a carrier"), `packages/core/tests/topics.test.ts` ("an automation of the account’s own: its where")._
