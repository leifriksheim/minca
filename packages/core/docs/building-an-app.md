# Building an app

A Minca app keeps its data in the person's own spaces, not on a server of
yours. On this page we'll build a small to-do list: connect, save a to-do, and
show the list as it changes.

## Connecting

Every app starts by asking the person for access, with
`createMincaConnection`. Wrap your app in `MincaProvider`, and use
`useConnection` to show a button until the person has said yes:

```tsx
declare function Todos(): React.JSX.Element;
// ---cut---
import { createRoot } from 'react-dom/client';
import { createMincaConnection } from '@minca/core/session';
import { MincaProvider, useConnection } from '@minca/react';

const connection = createMincaConnection({
  home: 'https://home.minca.social/connect',
  request: {
    name: 'Todo',
    access: 'write',
    create: [{ name: 'Todos', visibility: 'private' }],
  },
  network: { relays: ['wss://relay.minca.social'] },
});

createRoot(root).render(
  <MincaProvider connection={connection}>
    <App />
  </MincaProvider>,
);

function App() {
  const { connection, state } = useConnection();
  if (state.status !== 'ready') {
    return <button onClick={() => connection.connect()}>Connect with Minca</button>;
  }
  return <Todos />;
}
```

`home` is where the person's account lives. They see your app's name and what
it asks for, and pick which of their spaces to give it. `create` asks for a
new space just for your app, so there's somewhere to start.

Your app never sees the person's keys. It gets a key of its own, allowed into
the spaces it was given and nowhere else.

The connection is remembered between visits, and lasts a week. When it runs
out, `state.status` is `'expired'`, and connecting again renews it.

## The account home

The person's account, its settings and its other apps live at their home, not
in your app. Open it from a click, for the account your app acts for:

```ts
import type { MincaConnection } from '@minca/core/session';
declare const connection: MincaConnection;
// ---cut---
connection.openHome(); // the account page
connection.openHome('notifications'); // at a section of it
```

It opens in a window of its own, centred on yours. The home holds the
person's keys, so it is never shown inside your page.

## A collection

Records live in collections, like rows in a table. Say what a to-do looks
like:

```ts
import * as z from 'zod';
import { collection } from '@minca/core';

export const todos = collection({
  name: 'app.todo.item',
  title: 'To-do',
  schema: z.object({ text: z.string().min(1), done: z.boolean() }),
});
```

The definition is stored in the space itself, so any app that opens the space
knows what a to-do is. Add it once, with the `node` that `useNode()` gives
you in a component:

```ts
await node.collections.define(space.id, todos);
```

We'll look at schemas, rules and the shared standard collections in
[Collections](collections.md).

## Saving a record

```ts
await node.records.put(space.id, todos, { text: 'Buy milk', done: false });
```

The record is signed by the person, through your app's key, and syncs to
everyone else in the space. Because `todos` carries its schema, TypeScript
checks the body as you write it.

## Showing records

`useQuery` gives the records, and runs again whenever they change, here or
on someone else's device. `Todos`, which `App` shows once connected, picks the
space from the ones the person gave:

```tsx
import { useQuery, useSpaces } from '@minca/react';

export function Todos() {
  const { spaces } = useSpaces();
  const space = spaces[0];
  return space ? <TodoList space={space.id} /> : null;
}

function TodoList({ space }: { space: string }) {
  const { result } = useQuery(space, { collection: todos, sort: { '@createdAt': 'asc' } });
  if (!result) return null;
  return (
    <ul>
      {result.records.map((todo) => (
        <li key={todo.key}>{todo.body.text}</li>
      ))}
    </ul>
  );
}
```

That's a whole app. Share the space with a friend, and you both see the same
list.

## Next steps

- [Records and queries](records-and-queries.md): editing, deleting, filters
  and links between records.
- [Collections](collections.md): what a schema can say, and who may write
  what.
- [Spaces](spaces.md): making spaces, and inviting people to them.
- [Signing in](sign-in.md): for an app that keeps the account itself,
  instead of connecting to a home.
- [The node](node.md#react): every React hook.
