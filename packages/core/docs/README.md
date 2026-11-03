# Understanding Minca

Minca apps keep their data in spaces that people own, not on a server you
run. This page explains the few ideas everything else builds on. Read it
first, then [build a small app](building-an-app.md).

These docs ship inside `@minca/core`, so they always match the version you
have installed. An agent working in your app's repository finds them at
`node_modules/@minca/core/docs/`.

## The model in ten lines

- An **account** is a person. Its keys stay with them, and your app never sees them.
- A **space** is a shared place: who is in it, what each of them may do, and
  the data. Private spaces are encrypted end to end.
- A **collection** is a kind of record in a space, like `app.todo.item`.
- A **record** is a signed piece of JSON. Editing it makes a new version.
- A **role** says what its members may write. Every device checks every
  record it receives, so there is no server to trust.
- A **node** (`createNode`) does all of this for you: it signs, stores, checks and syncs.

That's the whole model. A few more ideas build on it, and each has its own
page when you need it:

- **Rules** and **contracts** say what a collection's records must keep to,
  like whose turn it is. See [Collections](collections.md) and
  [Contracts](contracts.md).
- **Computed fields** are values worked out from what links to a record,
  like "done once two people react 👍". See [Computed fields](computed.md).
- **Queries** are plain JSON, and typed when you pass a collection. See
  [Records and queries](records-and-queries.md).

## Guides

| Guide                                                | Read it to                                   |
| ---------------------------------------------------- | -------------------------------------------- |
| [building-an-app.md](building-an-app.md)             | Build a small to-do app                      |
| [collections.md](collections.md)                     | Say what your data is, and who may change it |
| [records-and-queries.md](records-and-queries.md)     | Write, edit, delete, query and watch records |
| [proposing-collections.md](proposing-collections.md) | Add collections to a space with no deploy    |
| [agents.md](agents.md)                               | Let an agent read and write as the person    |

## Reference

What the library does, in full. None of it is protocol, so another
implementation may do it differently and still sync. Some of it, like the
`std.*` collections, is a convention apps share: an app that ignores it still
syncs, but can't read what the others wrote.

| Page                                                 | Covers                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| [node.md](node.md)                                   | `createNode`: configuration, stores, events, the network, hosting, React |
| [sign-in.md](sign-in.md)                             | `createMincaAuth`: accounts, passkeys, staying signed in, pairing        |
| [actions.md](actions.md)                             | The node's actions, and the CLI, MCP and WebMCP tools made from them     |
| [query-format.md](query-format.md)                   | The JSON query format: filters, sort, paging, `include`                  |
| [standard-library.md](standard-library.md)           | Every `std.*` collection                                                 |
| [direct-messages.md](direct-messages.md)             | `std.direct`: text sealed for some members of a space                    |
| [blueprints-and-guides.md](blueprints-and-guides.md) | `std.blueprint` and `std.guide`: proposing, reviewing, updating          |
| [computed.md](computed.md)                           | Values every app works out the same way from what links to a record      |
| [contracts.md](contracts.md)                         | What a record must be to count, checked by every reader                  |
| [automations.md](automations.md)                     | `std.automation`: do something when records change, or at set times      |
| [bots.md](bots.md)                                   | Bots: who configures them, their instructions, connectors, GitHub        |
| [calls](../../calls/README.md)                       | Voice and video calls in a space                                         |
| [contacts.md](contacts.md)                           | `std.contact` and `node.contacts`                                        |
| [inbox.md](inbox.md)                                 | The inbox, and how a knock becomes a contact                             |
| [usernames.md](usernames.md)                         | `leif@minca.social`: looking up and claiming usernames                   |
| [spaces.md](spaces.md)                               | Making spaces, invites, profiles, the space manager                      |
| [warrants.md](warrants.md)                           | `std.warrant`: proof that an account broke the protocol's rules          |
| [storage.md](storage.md)                             | Sync pacing, storage adapters, IndexedDB, data folders, blob stores      |

The protocol itself, what goes over the wire and what every peer checks, is
in the [spec](https://github.com/leifriksheim/minca/tree/main/spec).

## Rules of thumb

- Import only from the package's entry points: `@minca/core` and its
  `/session`, `/schemas`, `/elements`, `/storage` and `/inbox`, and
  `@minca/react` for React.
- Name your collections `app.<yours>.<thing>`. `sys.*` belongs to the
  protocol and `std.*` to the standard library.
- Before you define a reaction, comment, tag, message, task or poll, look in
  the standard library (`@minca/core/schemas`). Using the same one is how two
  apps see each other's data.
- Keep anything other people should see in records. Records are what syncs.
- A refused write throws with the reason in plain words. Show it, or check
  first with `node.records.can` and hide the button.

## Planned in the library

The protocol's own plans are in [the spec](https://github.com/leifriksheim/minca/blob/main/spec/README.md).
In the library:

- **More typed queries.** Typed `where` inside an `include`, a misspelled
  collection name as a compile error, types generated from a space's stored
  definitions, and a warning in development when your schemas differ from
  the space's.
- **More computed fields.** On `records.get` and `records.list`, and a
  `linked()` that follows a record's own links.
- **Typed handles.** A collection bound to a space: `node.use(space, Poll)`.
- **Definitions that update themselves.** `useSchemas` and `applyBlueprint`
  applying harmless changes on their own.
- **Asking for what a version cites**, when it comes from a collection this
  node doesn't hold
  ([spec 09 §9](../../../spec/09-contracts.md#9-planned-asking-for-what-a-version-cites),
  [#138](https://github.com/leifriksheim/minca/issues/138)).
- **Web components** for the standard collections.
