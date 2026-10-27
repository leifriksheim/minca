# Proposing collections

A space can grow new collections without anyone deploying anything. Someone
proposes them as a **blueprint**, and someone who may define collections
applies it. An agent works this way, and so does a person whose role doesn't
let them define collections.

```typescript
import { proposeCollections, reviewBlueprint, applyBlueprint } from '@minca/core/schemas';

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

// Someone who may define collections reads what it would do, then applies it
const review = reviewBlueprint(proposal.body!, await node.collections.list(space.id));
await applyBlueprint(node, space.id, proposal.key);
```

- A blueprint is one `std.blueprint` record. Nothing is defined yet, so it
  can't break anything.
- `reviewBlueprint` says, per collection, whether it is new, a change, or the
  same, with a summary in sentences worked out from its rules. Show that to
  the person before they apply it.
- `applyBlueprint` defines each collection, signed by whoever applies it.
  They need a grant of `/collection/define` in the space, and a note that
  grants it.
- To change it, propose a new one with `updates: <its key>`.

Through `collections_propose`, a standard collection may be given by name
(`"std.task"`): `standardCollections` puts the library's definition in its
place.

## Trying a contract before proposing it

Anyone in a space can write records directly, not only through the app that
proposed a collection, so an app's own checks stop nobody. What records must
keep to for the app to mean anything (whose turn it is, a legal move, a
balance) belongs in the collection's [contract](collections.md#contracts),
which every reader judges.

A contract written wrong refuses fair moves, or lets a cheat count, and
nothing shows it until someone plays. So `collections_propose` takes
`examples`: versions it runs through their collection's schema and contract
before writing anything, so the proposer sees a mistake first.

```json
"examples": [
  { "collection": "app.counter", "body": { "n": 0 }, "expect": "pass" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 } }, "body": { "n": 5 }, "expect": "pass" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 } }, "body": { "n": 9 }, "expect": "fail" },
  { "collection": "app.counter", "prev": { "body": { "n": 4 }, "author": "did:key:z…" }, "body": { "n": 5 }, "author": "did:key:z…", "expect": "pass" }
]
```

- `author` is an account DID, the proposer's when left out. `prev` is the
  version before, `{ body, author?, links? }`, for a contract that reads
  `prev`; its author is this one's unless it names another, so turn-taking
  is tried by naming both. `creator`, who wrote the first version, is the
  version before's author, or this one's, unless given. Without `prev` the
  example is a first version.
- An example that should count must fit its collection's schema too.
- If any example comes out other than expected, nothing is proposed, and the
  error says which and why.
- A collection with a contract that no example names is still proposed, with
  a warning saying so. The warning goes to the proposer only: the person
  applying the blueprint sees the contract's conditions, not whether anyone
  tried them.
- What examples don't try: rules (`onePer`, `fixed`, `final`), who may write,
  and a contract's `line`. `member(did)` asks the space as it is now, not as
  of what the version saw. A cited version can't be given, so an example
  whose contract cites one never counts as `pass`.

_Source: `packages/core/src/schemas/blueprints.ts` (`tryContracts`), `packages/core/src/node/actions.ts` (`collections_propose`). Tests: `packages/core/tests/contracts.test.ts` ("checks: tried before they are proposed")._

## Saying how they are meant to be used

A definition can't say "write one rota for each week, and say in it who does
what". A guide can, and an agent finds it from `collections_list`:

```typescript
import { writeGuide } from '@minca/core/schemas';

await writeGuide(node, space.id, {
  name: 'chores.how',
  title: 'Keeping the rota',
  text: 'One rota record per week. It says who does what that week.',
  collections: ['chores.rota'],
});
```

## An app's own UI

Core runs no app's code. The example app lets a space add apps with a screen
of their own: a `launcher.app` record that points at its blueprint and holds
one HTML document, run in a sealed frame, as the person looking. It runs only
once someone who may define collections has written the record, under a note
that isn't records-only. The pieces
are in the repository: `apps/example/src/components/apps/launcher.ts`,
`screens.ts` and `ScreenFrame.tsx`, and `apps/example/public/screen.html`.

The details: [blueprints and guides](blueprints-and-guides.md).
