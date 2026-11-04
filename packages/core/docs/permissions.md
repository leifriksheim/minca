# Permissions

Every space decides who may do what in it, and every device enforces it.
There's no server to ask and no admin panel to trust: a change that breaks
the space's rules is refused by everyone, wherever it was written.

## Roles

Who may write lives in the space, not in your code or in a definition. A
role holds grants, and each grant is a command with a policy over its
arguments. "Hosts may delete any poll" is:

```typescript
import { RECORD_DELETE } from '@minca/core';

await node.spaces.defineRole(space.id, {
  name: 'host',
  title: 'Host',
  grants: [{ cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.poll']] }],
  nests: ['member'], // a host holds what a member holds too
});
await node.spaces.assign(space.id, did, 'host');
```

- `/record/write` and `/record/delete` see `collection` and `byCreator`, and
  a write also sees `body`. `byCreator` is whether the writer's account made
  the record's first version, and is true for a new record. So
  `['==', '.byCreator', true]` means "only your own".
- `/collection/define` adds or changes collections. It also needs a note that
  grants `/collection/define`, and an agent's note doesn't.
- You can't grant what you don't hold.
- The space's founders, if it has any, hold every command.

To ask before acting, `node.spaces.may(space.id, cmd, args)` says whether
this account may do something now, and `node.records.can(space, action, target)`
asks it for a record. Assigning, removing and roles that define roles are
covered in [spec 03](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

## Presets

A preset is a starting constitution: who sits at the top, the roles the space
is founded with and what each may do, and the roles you start with. Spread
one into `spaces.create`, change it, or write your own. Nothing checks a
preset's name.

| Preset      | `top`      | Roles                                      |
| ----------- | ---------- | ------------------------------------------ |
| `solo`      | `founders` | none: the founder alone                    |
| `team`      | `founders` | editor                                     |
| `community` | `founders` | admin, moderator, member                   |
| `coop`      | `none`     | steward (yours), member; no founder at all |

What each role may do:

| Role                  | Grants                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `team` editor         | `/record`, `/collection/define`, `/role/assign` with `.role == "editor"`                                                                                                                                                                               |
| `community` admin     | `/record`, `/collection/define`, `/role/assign`, `/role/define` for every role but admin, `/role/unassign` and `/member/remove` of anyone not an admin, `/std.automation/instruct`, `/space/succeed`, `/key/change`, `/space/relays`, `/space/keepers` |
| `community` moderator | `/record`, `/role/assign` with `.role == "member"`, `/std.automation/instruct`                                                                                                                                                                         |
| `community` member    | `/record/write` and `/record/delete` where `.byCreator` is true, outside `STAFF_COLLECTIONS`                                                                                                                                                           |
| `coop` steward        | `/record`, `/collection/define`, `/role/define` for member, `/role/assign` and `/role/unassign` of member or steward, `/member/remove` of anyone, `/std.automation/instruct`, `/space/succeed`, `/key/change`, `/space/relays`, `/space/keepers`       |
| `coop` member         | as `community` member, and `/space/succeed`                                                                                                                                                                                                            |

### Founders or no top

Under `top: founders` you are the founder, and hold every command whatever
the roles say. So no `founders` preset needs a role for you. Name others who
found it with you in `cofounders`.

Under `top: none`, as in `coop`, there is no founder. You hold only your
`creatorRoles`, here `steward`, and another steward can remove you.

### Changing each other's records

Every preset says whether members may change each other's records. A grant
of `/record/write` with no policy on `.byCreator` lets them. In `community`
and `coop`, members change only what they made, and moderators or stewards
change anything.

`STAFF_COLLECTIONS` are the standard collections only moderators start in a
community: announcements, badges, awards, pins, labels, channels, hosts and
the space's own profile (`std.space-profile`).

### What "anyone not an admin" protects

The policy on removing "anyone not an admin" reads the target's roles as the
remover sees them. It stops an admin who has seen another's promotion. It
doesn't stop one who acts on an older view, or at the same moment. So
`community` admins can still remove or demote each other that way. Where that
matters, give removal to fewer people, or to the founders alone.

See [spec 03 §2.3 and §3.2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

### Who defines a role

A role that may define itself can get stuck. If two of its holders rewrite
it differently, it keeps only what both versions share. If that drops
`/role/define`, nobody in the role can settle it.

So a preset gives `/role/define` for a role to another role, or to the
founders alone. In `community` the founders define admin, and admins define
the rest. In `coop` stewards define member, and nobody defines steward:
changing it takes a successor.

### `solo` never changes

The account's own derived spaces, the registry and the contacts space, use
`solo`'s roles byte for byte, and their ids depend on it. So `solo` must not
change. See
[spec 03 §13.1](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

## The top and founders

`spaces.access(id)` says who is at the top: `top` (`founders` or `none`),
`founder` on each member, and `founder` for this account.

Nobody removes or demotes a founder but the founder itself. So show no
remove button on a founder, and a "Step down" button on your own row when you
are one.

### Stepping down

```ts
await node.spaces.stepDown(space.id, { keep: 'admin' });
```

You stay, with the roles you hold, and are a founder no more. `keep` assigns
you that role first. With no role at all you would not be a member, so the
library refuses. To go altogether, `leave`.

Stepping down undoes whatever this account did elsewhere that hadn't seen it,
as leaving does. So step down from a device that has synced.

### Headless spaces

`access.headless` is true when no founder is left and no member may define
or assign any role. Members keep what their roles allow, but nobody can
change roles, and nothing in the constitution can change.

Say so plainly ("No one can change roles here any more"), and offer the way
on: naming a successor. Any member may do that once no member holds
`/space/succeed`.
