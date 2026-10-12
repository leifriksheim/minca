# Proposing collections

A space can grow new collections without anyone deploying anything. Someone
proposes them as a **blueprint**, and someone who may define collections
applies it. An agent works this way, and so does a person whose role doesn't
let them define collections.

```typescript
import { proposeCollections, reviewBlueprint, applyBlueprint } from '@weaveprotocol/core/schemas';

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

## Saying how they are meant to be used

A definition can't say "write one rota for each week, and say in it who does
what". A guide can, and an agent finds it from `collections_list`:

```typescript
import { writeGuide } from '@weaveprotocol/core/schemas';

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
