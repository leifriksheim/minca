# Proposing collections

A space can grow new collections without anyone deploying anything. Anyone
in the space can propose them, and someone who may define collections
applies the proposal. This is how agents add new things, and people whose
role doesn't let them define collections.

## Proposing

A proposal is a **blueprint**: one `std.blueprint` record listing the
collections. Nothing is defined yet, so it can't break anything.

```typescript
import { proposeCollections } from '@minca/core/schemas';

const proposal = await proposeCollections(node, space.id, {
  title: 'Chores',
  description: 'Who does what around the house this week.',
  collections: [
    {
      name: 'chores.rota',
      title: 'Rota',
      schema: {
        type: 'object',
        properties: { week: { type: 'string' }, who: { type: 'string' } },
        required: ['week', 'who'],
      },
      rules: { fixed: ['week'] },
    },
  ],
});
```

Through the `collections_propose` tool, a standard collection can be given by
name alone, like `"std.task"`. `standardCollections` puts the library's
definition in its place.

## Reviewing and applying

Before applying a blueprint, show the person what it would do.
`reviewBlueprint` says, for each collection, whether it is new, a change, or
the same, with a summary in sentences worked out from its rules:

```typescript
import type { NodeRecord } from '@minca/core';
import { reviewBlueprint, applyBlueprint, type Blueprint } from '@minca/core/schemas';

async function apply(proposal: NodeRecord<Blueprint>) {
  const review = reviewBlueprint(proposal.body!, await node.collections.list(space.id));
  // Show the review to the person, and apply only if they agree
  await applyBlueprint(node, space.id, proposal.key);
}
```

`applyBlueprint` defines each collection, signed by whoever applies it. They
need a grant of `/collection/define` in the space, and a note that grants it.

## Updating a proposal

To change a blueprint, propose a new one with `updates: <its key>`.

## Trying a contract before proposing it

Anyone in a space can write records directly, not only through your app. So
your app's own checks stop nobody. What records must keep to for your app to
mean anything, like whose turn it is or a legal move, belongs in the
collection's [contract](collections.md#contracts), which every reader checks.

A contract written wrong refuses fair moves or lets a cheat count, and
nothing shows it until someone plays. So `collections_propose` takes
`examples`. It runs each one through its collection's schema and contract
before writing anything:

```json
"examples": [
  { "collection": "app.counter", "body": { "n": 0 }, "expect": "pass" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 } }, "body": { "n": 5 }, "expect": "pass" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 } }, "body": { "n": 9 }, "expect": "fail" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 }, "author": "did:key:z…" }, "body": { "n": 5 }, "author": "did:key:z…", "expect": "pass" }
]
```

If any example comes out other than expected, nothing is proposed, and the
error says which one and why.

### What an example can say

| Field     | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `author`  | The account DID that writes it. The proposer's when left out.                      |
| `prev`    | The version before: `{ body, author?, links? }`. Leave it out for a first version. |
| `creator` | Who wrote the first version. Defaults to `prev`'s author, or this one's.           |
| `expect`  | `"pass"` or `"fail"`.                                                              |

`prev`'s author is this example's unless it names another, so to try
turn-taking, name both. An example expected to pass must fit its
collection's schema too.

### What examples don't try

- Rules (`onePer`, `fixed`, `final`), who may write, and a contract's `line`.
- `member(did)` asks about the space as it is now, not as the version saw it.
- A cited version can't be given, so an example whose contract cites one
  never passes.

A collection with a contract that no example names is still proposed, with a
warning. Only the proposer sees the warning. The person applying the
blueprint sees the contract's conditions, not whether anyone tried them.

## Saying how they are meant to be used

A definition can't say "write one rota for each week, and say in it who does
what". A guide can, and an agent finds it through `collections_list`:

```typescript
import { writeGuide } from '@minca/core/schemas';

await writeGuide(node, space.id, {
  name: 'chores.how',
  title: 'Keeping the rota',
  text: 'One rota record per week. It says who does what that week.',
  collections: ['chores.rota'],
});
```

## An app's own screen

Core runs no app's code. The example app lets a space add apps with a screen
of their own: a `launcher.app` record that points at its blueprint and holds
one HTML document. It runs in a sealed frame, as the person looking, and only
once someone who may define collections has written the record under a note
that isn't records-only.

The full details are in [Blueprints and guides](blueprints-and-guides.md).
