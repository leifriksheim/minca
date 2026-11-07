# Records and queries

A record is one piece of your app's data: a to-do, a vote, a message. This
page shows how to write records, change them, delete them, and find them
again with a query that stays live as they change.

The examples use the `todos` collection from [Building an app](building-an-app.md).

## Writing a record

`put` makes a new record and gives it back:

```typescript
const todo = await node.records.put(space.id, todos, { text: 'Buy milk', done: false });
todo.key; // 'akthxqofxox3iszhpi5j3zhl6a.mfrggzdfmztwq2lknnwg23tpoa'
```

The record gets a fresh `key`. The key stays the same for the record's whole
life, so it is what you keep, read by and link to.

Pass the collection's definition, as here, and TypeScript checks the body as
you write it. You can also pass a collection's name as a string, and the body
is untyped.

## Editing a record

`update` writes the record's next version:

```typescript
await node.records.update(space.id, todo.key, { text: 'Buy milk', done: true });
```

It takes the whole new body, not a patch. Every edit is a new version, and it
syncs to everyone in the space.

## Deleting a record

```typescript
await node.records.delete(space.id, todo.key);
```

A delete is a version too, marked deleted, and it syncs like any other.

## Who may write

A write your account isn't allowed to make throws, with the reason in plain
words, and nothing is signed. To ask first, for example to hide a button:

```typescript
const mayEdit = await node.records.can(space.id, 'edit', todo.key);
```

The action is `'create'`, `'edit'` or `'delete'`. For `'create'`, name the
collection instead of a key. In React, `useCan(space, action, target)` gives
the same answer.

Who may write what is set by the collection's rules and the space's roles. See
[Collections](collections.md#rules).

## Links

A record can point at other records. Here a vote points at the poll it is
about, and `linked` finds what points at the poll:

```typescript
const poll = await node.records.put(space.id, 'app.poll', { question: 'Where to?' });
await node.records.put(space.id, 'app.vote', { choice: 0 }, { links: [{ rel: 'about', to: poll.key }] });

const votes = await node.records.linked(space.id, poll.key, { rel: 'about' });
```

`rel` is the link's role. The roles a record may carry are declared on its
collection ([Collections](collections.md)).

`update` keeps a record's links unless you pass new ones.

## Querying

A query asks for the records of one collection, filtered and sorted:

```typescript
const { records } = await node.records.query(space.id, {
  collection: todos,
  where: { done: false },
  sort: { '@createdAt': 'desc' },
  limit: 20,
});
```

A query is plain JSON, so you can store it, send it, or have an agent write
it. A malformed query throws, saying what to fix.

## Filters

`where` names fields and what they must be. A bare value means "equals":

```typescript
await node.records.query(space.id, {
  collection: todos,
  where: { done: false, text: { $contains: 'milk' } },
});
```

- A plain name is a field of the body (`text`, `address.city`), or one of the
  collection's [computed fields](computed.md).
- A name starting with `@` is about the record itself: `@key`, `@author`,
  `@root`, `@createdBy`, `@createdAt`, `@updatedAt`, `@seq`.
- `link:<role>` is where the record's first link of that role points.

The operators are `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`,
`$exists` and `$contains`. Combine filters with `$and`, `$or` and `$not`.
`$ne` is true for a missing field. `$contains` is a case-insensitive
substring, or an element of a list. It is not full-text search.

Every operator and field is in [The query format](query-format.md).

## Sorting and paging

`sort` takes several fields, applied in order. Ties break on the key.

When there are more records than `limit`, the result has a `cursor`. Pass it
back to get the next page. It is `null` on the last one.

```typescript
const page1 = await node.records.query(space.id, { collection: todos, limit: 20 });
const page2 = await node.records.query(space.id, {
  collection: todos,
  limit: 20,
  cursor: page1.cursor ?? undefined,
});
```

## Following links

`include` brings related records along with each result. Here each poll comes
with its votes, and the number of reactions to it:

```typescript
const { records } = await node.records.query(space.id, {
  collection: 'app.poll',
  include: {
    votes: { rel: 'about', from: 'app.vote' },
    reactions: { rel: 'about', from: 'std.reaction', count: true },
  },
});
records[0]?.included.votes;
```

By default an include finds records that link to this one
(`direction: 'in'`). `direction: 'out'` finds the ones this record links to.
Each include takes its own `where`, `limit` and nested `include`, or
`count: true` for just the number.

## Typed results

Name collections by their definitions, in `collection` and `from`, and the
results are typed: bodies, includes and computed fields. `where` and `sort`
are typed too, so a field the collection doesn't have, or a value of the wrong
type, is a compile error. A collection named by a string is untyped.

## While a space loads

The result's `complete` is false while a node that holds only part of a
space is still fetching a collection the query needs. Show "Loading…", not
"Nothing here".

## Live results

`watch` runs a query now, and again whenever the space's records change, here
or on someone else's device:

```typescript
const stop = node.records.watch(space.id, { collection: todos }, (result) => {
  console.log(result.records.length, 'to-dos');
});
stop();
```

In React, `useQuery(space, query)` does the same. `useRecord(space, key)`
keeps one record current, and `useLinked(space, key, { rel })` what links to
it.

For anything else, subscribe to the node's events:

```typescript
const unsubscribe = node.subscribe((event) => {
  if (event.type === 'records') console.log('records changed in', event.space);
});
```

## What a record looks like

Every record the node gives you is a
[`NodeRecord`](https://minca.dev/api/core/interfaces/NodeRecord/): its `key`,
its `body`, its `links`, who wrote it and whether it checks out.

A query gives each as a
[`QueryRecord`](https://minca.dev/api/core/interfaces/QueryRecord/), which
adds what the collection's [computed fields](computed.md) work out on this
device and what its `include` found.

Show `root` or `createdBy` as the author. `author` is the app's key that
signed, not the person. `node.spaces.profiles(space)` maps accounts to names.

## Keys

A record's key says whose it is. Every key starts with its owner's part, a
hash of the account, so no one else can create a record there.

Most records just take the fresh key `put` gives them. Some records there is
one of per account, like settings. For those, pass a name:

```typescript
await node.records.put(space.id, 'app.settings', { theme: 'dark' }, { key: 'settings' });

const mine = await node.records.keyFor(space.id, 'settings'); // 'akthxqofxox3iszhpi5j3zhl6a.settings'
const theirs = await node.records.keyFor(space.id, 'settings', did); // someone else's, if they wrote one
await node.records.get(space.id, theirs);
```

- The name goes in your account's namespace, so two accounts that both
  choose `settings` get two records.
- Names are 1–101 characters of `a`–`z`, `0`–`9` and `: . _ -`.
- Read and link records by their whole `key`, as `put` gives it, not by the
  name.
- A name is the same key in every collection, and a record keeps its
  collection for life. So `put` refuses a name you already hold in another
  collection, deleted or not. Put the collection in the name
  (`app.todo.settings`) so two of your apps never clash.
- Writing a deleted key brings the record back. Pass the whole key when it is
  already yours.
- A name of the form `one:<hex>` is refused outside a `onePer` collection.

In a collection with a `onePer` rule, the node works out the key for you
from the parts the rule names, and `node.records.onePerKey` tells you what it
is. With `@author` the key is the writer's. Without, it is a shared `one:…`
key ([Collections](collections.md#rules)). In a private space it is keyed with
the space's key, so it says nothing to someone who can't read the space.

An account's line in a collection, for contracts, has the key
`lineKey(account, collection)`, exported by `@minca/core`.

Every peer refuses a first version at a key the writer doesn't own. The rule
is in [spec 02 §4.1](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## When two devices edit at once

Each edit raises the record's `seq` by one. The version with the higher `seq`
wins. On a tie, the version id decides. Clocks play no part, so two devices
that edited apart agree on the same winner.

Edits inside one record are not merged. Design records so that people edit
different ones: one record per vote, per card, per reaction.

## History

`node.records.history(space, key)` gives the versions this node keeps whole,
newest first. That is the current one, or every one in a collection defined
with `history: 'all'`. Otherwise an earlier version's body is forgotten once
it is replaced.
