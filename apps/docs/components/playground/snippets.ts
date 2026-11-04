/** The code each step shows: what the playground itself runs, cut down to the part that step is about. */

export const connectCode = `import { createMincaConnection } from '@minca/core/session';
import { MincaProvider, useConnection } from '@minca/react';

const connection = createMincaConnection({
  home: 'https://home.minca.social/connect',
  request: {
    name: 'Minca playground',
    access: 'write',
    // A space made just for this app, so there's somewhere to start
    create: [{ name: 'Playground', visibility: 'private' }],
  },
  network: { relays: ['wss://relay.minca.social'] },
});

function App() {
  const { connection, state } = useConnection();
  if (state.status !== 'ready') {
    return <button onClick={() => connection.connect()}>Connect with Minca</button>;
  }
  return <Spaces />;
}

createRoot(root).render(
  <MincaProvider connection={connection}>
    <App />
  </MincaProvider>,
);`;

export const spacesCode = `import { useSpaces } from '@minca/react';

function Spaces() {
  const { spaces } = useSpaces();
  const [space, setSpace] = useState<string>();

  if (space) return <List space={space} />;
  return spaces.map((s) => (
    <button key={s.id} onClick={() => setSpace(s.id)}>
      {s.name}
    </button>
  ));
}`;

export const collectionsCode = `import { useNode } from '@minca/react';
import { listItem, useSchemas } from '@minca/core/schemas';

const node = useNode();

// Defines what the space doesn't know yet, and leaves the rest:
// safe to call every time a space opens.
await useSchemas(node, space, [listItem]);

const defined = await node.collections.list(space);`;

export const recordsCode = `import { useNode, useQuery } from '@minca/react';
import { listItem } from '@minca/core/schemas';

function List({ space }: { space: string }) {
  const node = useNode();
  const { result } = useQuery(space, {
    collection: listItem,
    sort: { '@createdAt': 'asc' },
  });

  const add = (text: string) => node.records.put(space, listItem, { text });

  return (
    <ul>
      {result?.records.map((item) => (
        <li
          key={item.key}
          onClick={() =>
            node.records.update(space, item.key, { ...item.body, checked: !item.body.checked })
          }
        >
          {item.body.checked ? '✓' : '○'} {item.body.text}
        </li>
      ))}
    </ul>
  );
}`;

/** The screen step's starting point: small enough to read at a glance, and editable. */
export const screenCode = `<script>
  const { html, render, useRecords } = ui;

  function App() {
    const items = useRecords('std.list-item');
    if (!items) return null;

    const add = (event) => {
      event.preventDefault();
      const input = event.currentTarget.elements.text;
      minca.put('std.list-item', { text: input.value });
      input.value = '';
    };
    const tick = (item) =>
      minca.update(item.key, { ...item.body, checked: !item.body.checked });

    return html\`<main>
      <h1>Our list</h1>
      <ul>
        \${items.map((item) => html\`<li key=\${item.key}>
          <label>
            <input type="checkbox" checked=\${!!item.body.checked}
              onChange=\${() => tick(item)} />
            \${item.body.text}
          </label>
        </li>\`)}
      </ul>
      <form onSubmit=\${add}>
        <input name="text" placeholder="Add something" required />
      </form>
    </main>\`;
  }

  render(html\`<\${App} />\`);
</script>`;

/** std.list-item, written as anyone would write a collection of their own. */
export const definitionCode = `import * as z from 'zod';
import { collection } from '@minca/core';

export const listItem = collection({
  name: 'std.list-item',
  title: 'List item',
  description: 'One thing on a list: text, a link, a person or a record.',
  schema: z.object({
    text: z.string().max(1000).optional(),
    url: z.string().min(1).max(2048).optional(),
    did: z.string().min(1).max(256).optional(),
    checked: z.boolean().optional(),
    quantity: z.number().min(0).optional(),
    position: z.string().min(1).max(200).optional(),
  }),
  links: {
    in: { to: ['std.list'], cardinality: 'one' },
    about: { to: '*', cardinality: 'one' },
  },
});`;
