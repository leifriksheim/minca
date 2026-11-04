# Warrants

A **warrant** (`std.warrant`) is proof that an account's key signed something
every peer refuses and no honest app would sign. Your app uses warrants to
show the members of a space that someone broke the rules, so whoever may
remove members can decide what to do.

Nodes write warrants for you, and every member's node checks the proof itself
before it shows an account as flagged. Nothing happens to the account
automatically. A peer that has never heard of warrants syncs and judges
everything the same. It just shows no flags.

## Showing who is flagged

`spaces.access(id).flagged` lists every account this node has checked proof
against:

```ts
const { flagged } = await node.spaces.access(space.id);
// [{ account, key, kind, by, offence }]
```

Each entry is one warrant:

| Field     |                                                     |
| --------- | --------------------------------------------------- |
| `account` | The account accused                                 |
| `key`     | The key that signed it: one device or app of theirs |
| `kind`    | What it broke: `chain`, `standing` or `access`      |
| `by`      | The account that brought the proof                  |
| `offence` | The id of the offending version                     |

Several members may bring proof against one account, so an account can appear
more than once.

Show the flag to the space's members. One granted `/member/remove` may remove
the person with `spaces.removeMember(id, did)`.

Show it to the account itself too. A flag against your own account usually
means one of your keys is being used somewhere it shouldn't be. Revoking that
key with `spaces.revoke` takes back what it signed.

## When a warrant counts

A warrant flags someone only when it:

- is a first version, standing as a record;
- is in `std.warrant`, and not against its own writer;
- has evidence that is exactly what its ids name, envelope and body;
- proves its kind's check.

Anything else flags nobody. That covers false, malformed and unknown kinds,
and it earns the writer nothing either. Each warrant is judged once, whether
it holds or not, so a false one costs a node one check.

## The record

```
std.warrant at a fresh key of its writer's
{ kind, evidence: [<version>, <version>?] }        retain: true
```

`evidence[0]` is the offending version. Its signer's root is the accused
account.

The record's key is the writer's own, so nobody can write its first version
but the writer, the accused least of all. Only that first version counts as
proof. Whoever the space's grants allow may write a later version or delete
it, as for any record, but neither takes the proof back. The writer sets
`retain`, so the first version is kept whole.

One offence counts once per writer, however many records say it.

## Kinds

| `kind`     | `evidence`                                        | Proves                                                                                                                |
| ---------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `chain`    | `[v, p]`, both without bodies                     | `p.id = v.prev`, and `v` doesn't follow `p`                                                                           |
| `standing` | `[v]`, without its body; not an access collection | In `v`'s own view: its root was no member, the rules said `final`, or a first version's root had no grant to write it |
| `access`   | `[v]`, whole; an access collection                | In its own view, `v`'s event is refused by its author's power                                                         |

For `standing`, policies on the body are left out of the grant check.

A version's **own view** is the access changes its `seen` names, and
everything they saw, replayed alone. That's what its writer's node had when
it signed. Nothing outside it can change the verdict, so an honest writer
never fails it.

See [spec 02 §4](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)
and [spec 03 §4.5](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)
for the checks themselves.

## How a node writes one

When your node refuses a version that proves one of the kinds above, it
writes a warrant of its own. It skips this if one of its own warrants against
that account already stands. So one account's misconduct costs each member
one warrant at a time.

The node looks through the cheap global view first, and replays the own view
only for what that finds broken. A flag can be missed, but is never false. A
race, like a write that crossed a removal it hadn't seen, is withdrawn rather
than refused, so it earns no warrant.

## When a warrant goes away

Like any record, a warrant is withdrawn when its writer is removed by a change
whose cutoff doesn't cover it, or revokes the key that signed it
([#166](https://github.com/leifriksheim/minca/issues/166)).

More kinds are planned after v1, in
[#148](https://github.com/leifriksheim/minca/issues/148).
