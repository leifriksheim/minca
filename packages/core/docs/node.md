# The node

A node is what takes part in Minca for an account. It holds the account's
spaces, signs what it writes, checks what peers send, and keeps everything in
sync. Most apps never make one: the connection starts it for you
([building an app](building-an-app.md)). You make one yourself in a program
that holds the account's keys, such as a script, a server or a test.

```ts
import { createNode, deriveAccountKey, generateSeed, indexedDBStores, rootFromSeed } from '@minca/core';

const seed = generateSeed();
const { signer } = await rootFromSeed(seed);

const node = await createNode({
  signer,
  accountKey: await deriveAccountKey(seed),
  stores: indexedDBStores('my-app'),
  network: { relays: ['wss://relay.minca.social'] },
});

const space = await node.spaces.create({ name: 'Notes', visibility: 'private' });
await node.records.put(space.id, 'app.note', { text: 'Hello' });
```

## Configuration

`createNode(config)` takes a [`NodeConfig`](https://minca.dev/api/core/interfaces/NodeConfig/),
whose page gives each field's meaning and default. The sections below explain
the ones that work together: [root signers](#root-signers-and-notes),
[stores](#stores), [writer keys](#writer-keys) and
[holding part of a space](#holding-part-of-a-space).

### Collections the node knows

`collections` gives the node schemas to use when a space doesn't describe a
collection itself. Writes are checked against them, and reads are flagged
`conforms`. Nothing arriving from a peer is refused for its shape.

### Network options

`network` is a [`NodeNetworkConfig`](https://minca.dev/api/core/interfaces/NodeNetworkConfig/):
the relays where peers meet, always-on nodes to dial, hosts to look for the
account registry at, and more. Omitted, the node stays offline.
[The network](#the-network) says how the node uses them.

## Lifecycle

When it starts, a node picks its signing key: `sessionKey` if given, else one
claimed from `writerKey`, else a fresh P-256 key for this run. Its DID is
`node.sessionDid`. Then it asks the signer for a session note and waits. If
the signer refuses, `createNode` fails.

With an account key, the node also opens the account registry and makes its
spaces match it before `createNode` returns
([following the account](#following-the-account)).

A node acts for one account (`node.did`) and signs with one key for its whole
life. To act for another account, start another node.

### Revoking keys

`revokeKey(key, { spaces?, waitMs? })` revokes one of the account's keys, with
a cutoff at what that key wrote. By default it does this wherever the account
writes: every space it lists, its carry spaces, the contacts space and the
account registry. It says whether a peer took each revoke in within `waitMs`.
The account home calls it when you disconnect an app.

`revokeSelf()` does the same for the node's own key, and forgets a lasting
key at once. The account home calls it on sign-out.

A record is judged with no clock, so it is a revoke, not the note running out,
that ends what a key can write. An agent can't call either.
[Spec 01 §7.4](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

### Closing

`close()` stops renewing the note, closes every open space and the registry,
and drops all event listeners. After that, any call that needs a space fails
with `Node is closed`. Closing twice does nothing.

## Root signers and notes

A node never holds the account's root key. It gets a **root signer**, which
hides where the key lives and is only asked for notes.

Its interface is [`RootSigner`](https://minca.dev/api/core/interfaces/RootSigner/): the
account's DID, and `delegate`, which issues a note from the account to a key.

There are three kinds:

- **Local**, `createLocalRootSigner`, signs with the root key itself.
  `subject` defaults to the whole account and `policy` to none.
- **Grant**, `grantSigner`, is what an app uses. It returns the one note the
  account home gave the app, and refuses once the grant has expired. It can't
  make new notes.
- **Across a port**, `serveSigner` on the side with the key and
  `remoteSigner` on the node's side, as a page signs for its worker. It signs
  only session notes (command `/`, no subject, no policy) and refuses anything
  else without asking the signer behind it.

### The session note

This is the note a node asks for when it starts:

```
aud = session DID
sub = the account's DID
cmd = "/"                     (an agent's node signs under its grant, `/record`)
pol = []
exp = now + sessionTtlSeconds (default 3600)
nbf = now − 300
```

Peers only check that the note grants what each record needs, so the command
is the node's choice.

### Issuing notes

`issueDelegation` defaults `exp` to an hour from now, `nbf` to five minutes
ago so a peer with a slow clock still accepts it, `nonce` to 12 random bytes,
`subject` to the issuer and `policy` to `[]`. It signs in low-S form only.

Only the account's root signer issues notes that peers accept, and a note is
never passed on. A key that needs another key, such as a helper or a key per
tab, asks the account for a note of its own.

### What a home grants

`grantTerms(access, spaces)` turns a grant into a note's terms: the command
`/`, `/record` or `/record/read`, and the whole account, one space, or several
spaces named by a policy. `noteSpaces(note)` reads that back, to show which
spaces a note reaches. It never claims more than the note grants.
[Spec 01 §7](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md),
[spec 06 §2.5](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## Renewing the session note

The node asks for a new note three quarters of the way through the old one:
2700 seconds in, with the default lifetime. Each renewal schedules the next.

If the signer refuses or can't be reached, the node keeps its note and asks
again after `min(60, ttl / 4)` seconds, until it succeeds or the node closes.
Once the note expires, live checks refuse it: knocks, live messages and
connecting to peers. Records it signed still count until its key is revoked.

A node started from a grant never gets a fresh note. `grantSigner(grant)`
answers every renewal with the same note, and when that runs out the app must
connect again. `grantSigner(() => grant)` answers with whatever grant the
getter returns, so a renewed grant can replace the last.

`node.delegation()` returns the note the node writes under now.
[Spec 06 §1.2](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## Stores

A node asks its `StoreFactory` for stores by path:

| Path               | Holds                                                 | Sealed |
| ------------------ | ----------------------------------------------------- | ------ |
| `registry`         | the node's list of spaces and their keys              | yes    |
| `spaces/<spaceId>` | one space's records, and what the node keeps about it | no     |
| `writers`          | each lasting key's place in each line                 | no     |

It also opens `mirrors/<spaceId>/<n>` for a [mirror](storage.md#mirrors),
`folder/<spaceId>` for a data folder, and `host` for a host's subscriptions.

What a path means is up to the factory:

- `indexedDBStores(prefix)` makes one IndexedDB database per path, named
  `<prefix>:<path with / replaced by :>`. It never seals, since the browser
  profile already guards it.
- `folderStores(directory, { basePath?, localKey?, local? })` uses a
  [data folder](storage.md#data-folders). The `registry` goes in the folder
  under `basePath`, sealed under `localKey` (`deriveLocalKey(seed)`) when
  given. Every other path goes in `local`, and each space is mirrored to the
  folder's segments.
- `directoryStores(directory, { localKey? })` uses a directory on this
  device, one file per entry and per version, sealing the `registry` the same
  way.

[Sign-in](sign-in.md) picks stores with `storesFor(account)`: IndexedDB with
prefix `minca:<dataPath with : for />` in the browser, or `folderStores(pod,
{ basePath: account.dataPath, localKey })` in a pod, where `dataPath` is
`accounts/<id>/stores`. A connected app uses
`indexedDBStores('minca-app:<account DID>')`. These names may change
([sync and storage](storage.md#indexeddb)). A pod's layout is in
[spec 05](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

### Copying an account

`copyAccountData({ from, to, did, accountKey? })` copies every space an
account holds, with its keys and records, from one set of stores to another.
With `accountKey` it copies the account registry too. It merges by the same
rule as sync, so copying into a store that has some of it already is safe,
and copying twice changes nothing.

> **Known defect:** `copyAccountData` stores versions without validating
> them, so a pod another origin wrote to can
> bring in versions a peer's would have been refused. Tracked in
> [#20](https://github.com/leifriksheim/minca/issues/20).

### Places in a key's line

Every version a key signs in a space takes the next place in that key's line
for the collection. Writes by one key in one space go one at a time, and the
place is saved before the version leaves the node. Where it is saved depends
on the key:

- **A key made for this run** keeps its places in memory.
- **A writer key** (`config.writerKey`) keeps them beside the key.
- **A key handed in** (`config.sessionKey`) or a carrier's key keeps them in
  the `writers` store, so a restart carries on.

A handed-in key may sign in several nodes at once: every tab of an app signs
with the app's key. So each place is taken under a Web Lock
(`minca-writer:lines/<did>/<space>`) shared by the origin's tabs and workers,
and read fresh from the store each time. Nodes that share a key must share
that store too. Two nodes signing with one key from separate stores fork its
lines, and every peer then withdraws what it signed in a forked collection
from the fork on.
[Spec 02 §4.10](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

### Writer keys

With `writerKey`, a node claims a lasting key when it starts and signs with
it until it closes. The device then keeps one log in each space, instead of
a new one each run. A key goes to one node at a time. If every key is taken,
or none can be locked, the node makes a key for this run instead.

In the browser, `browserWriterKeys(name)` keeps up to 32 keys in IndexedDB,
one database per slot (`<name>:writer:<slot>`), each claimed under a Web Lock
of the same name. A tab that finds a slot taken tries the next. A tab that
closes or crashes frees its slot. The private key can't be extracted: a
script in the page can sign with it while it runs, but can't take it away.
Without IndexedDB or Web Locks there are no writer keys.

A node started from a store description, such as `startPageNode` or a node in
a worker, claims its key under the account's IndexedDB prefix, even when its
stores are in a data folder. So signing out (`deleteBrowserData`) deletes the
keys too, and a key never goes in a data folder that other apps share.

What happens when a key goes away:

- `forget()` drops the key but keeps its places, which still count for this
  run. The slot's next claim makes a new key and clears them.
- `revokeSelf` forgets the claimed key before it writes a single revoke, so a
  page closed mid-way leaves no revoked key to claim again. With a peer
  connected in any open space, each revoke waits up to `waitMs` for one to
  take it in.
- A node that claims a key the account registry has revoked forgets it, and
  uses a key for this run. The next start claims a new lasting one.
- A node never signs at a place behind one it already took this run. If the
  slot lost its places (site data cleared while the page was open), every
  write fails until the page reloads, since signing on would fork the line.
  A slot whose connection the browser closed reopens only while it still
  holds the key.

The CLI keeps its writer keys outside its home, in
`<local>/writer-keys/slot-<n>/` ([data folders](storage.md#data-folders)).
The key is sealed under the account's local key in `key.sealed` (mode 600,
label `minca/writer-key/v1`, bound to `{ did, slot }`), so a copy of the files
can't sign, and a key moved to another slot or account is refused. Its places
are in `heads/`, and numbered `lock.<n>` files name the process holding it,
taken over once that process is gone.

## Opening and holding spaces

A space opens the first time anything asks for it: a read, a write, a status.
Opening reads its store, joins its peers and starts syncing. It also
publishes the account's profile there, checks whether the node's note was
revoked there ([`revoked`](#events)), and names the account's carriers as
keepers if the account manages the space.

The space stays open until it is released or the node closes.
`spaces.hold(id)` keeps it open, and resolves to a function that lets go:

```ts
const release = await node.spaces.hold(space.id);
// later
await release();
```

- Holds are counted per space. At zero, the space closes.
- Releasing twice does nothing.
- A hold from before the space was left is tied to that time. Releasing it
  later doesn't touch a hold made after rejoining.
- Reading and writing need no hold.

Anything that needs a space live holds it, such as a screen or a call. That
way a screen going away never cuts off a call in the same space.

## Leaving a space

`spaces.leave(id)` first gives up the account's place. It writes a
`sys.remove` naming the account, so the others stop counting it a reader and a
private space's key changes. Leaving needs no grant. Then it deletes the
space's `sys.joined` record, closes the space and forgets it with its keys.

A founder who leaves is a founder no more, for good. To stay without being
one, use [`spaces.stepDown`](permissions.md#the-top-and-founders).

- The removal waits up to 5 seconds for a peer of another account to have
  it. With nobody reachable, the node leaves anyway.
- Another device of the account that sees the `sys.joined` record go, while
  the account still holds a place, writes the removal itself.
- Shared to view, or the last reader left, there's nothing to write, and
  `leave` returns at once.
- A narrow app note that may not change access can't write the removal.
  `leave` still forgets the space, and another device writes it.

The account registry, the contacts space and carry spaces can't be left.
`contacts.remove` and `contacts.block` leave the space for two this way.
[Spec 03 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

## Holding part of a space

A node doesn't need every record in a space. With `config.cache`, once a space
names at least one keeper, the node holds only the collections it uses, plus
the space's own `sys.*` collections. Apps connected to an account home do this
by default.

```ts
declare const signer: RootSigner;
// ---cut---
import { createNode, indexedDBStores, type RootSigner } from '@minca/core';

const node = await createNode({
  signer,
  stores: indexedDBStores('my-app'),
  cache: { collections: ['app.todo.item'] },
});
```

`cache` is a [`CacheConfig`](https://minca.dev/api/core/interfaces/CacheConfig/): the
collections to hold from the start, when to drop one nothing uses, and how
many keepers a write must reach.

### What gets held

- A query marks every collection it reads as used, including each
  `include … from`, and a write marks the one it writes. Sync then fetches
  them.
- Until the node has caught up once with a node holding the whole space, it
  can't know whether the space names keepers, so it holds only what it uses.
- An unused collection is dropped when the space opens, and every 6 hours
  while it stays open. It stops being held before its versions go, so nothing
  syncs it back meanwhile. A collection with a pending write is never dropped.
- A space that names no keeper is held whole.
- The account registry, the contacts space and carry spaces are always held
  whole.
- When what it holds changes, the node says hello to every peer again.

### Complete results

A query's result has `complete: false` until, for every collection it reads,
the node has been level once with a node holding the whole space, and it
lacks nothing a writer's line there names. A version that names one the node
doesn't have adds it to `missing`, and the node asks every peer for it by id.
It asks again whenever the collection is level with a peer.

So what a keeper withholds from the middle of a writer's line shows up as
missing. A writer's newest versions aren't named by any line yet, so holding
those back would take every peer the node syncs with.

### Pending writes

In a space that names keepers, every node's own writes are _pending_ until
`min(keepers named, max(copies ?? 2, cache.copies ?? 0))` keepers have them. A
keeper's own node counts as one. A keeper confirms a write with `stored`, or by
being level with the writer on its collection. Only peers named in
`sys.keepers` count. A node holding part of a space keeps pending writes in
its store across runs. One holding all of it keeps the latest 4096 in memory.

`node.spaces.kept(spaceId, waitMs, since?)` waits up to `waitMs`, at most a
minute, for this node's writes to be kept elsewhere:

- In a space with keepers, it says `'keepers'` once none of its writes from
  `since` (ms) on is pending.
- In a space without, it says `'peer'` once a connected peer holds all this
  node does. That's less sure, since the peer may be a device that goes away.
- It says `null` if nobody had them in time.

Wait on it before a node stops: a tab about to close, a command about to exit,
a server's node at the end of its job.

### What the node stores

This state lives in the space's own store, `spaces/<spaceId>`:

| Key                    | Value (JSON)                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| `cache`                | `{ settled, used, level, missing }`, below                           |
| `pending/<version id>` | `{ collection, by: [keeper DID…], at }`, deleted once `by` is enough |

In `cache`, `settled` says whether the node has synced with a whole-space
peer. `used` maps each collection to when a query last used it, `level` to
when it was first level with a whole-space peer, and `missing` to the version
ids a writer's line names that aren't here.
[Spec 05 §9](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

### Planned: caches that widen and trim

> **Planned.** A node holding part of a space would hold all of it when too
> few keepers are online (opt-in, `cache.widen: true`), and drop least
> recently used collections above `cache.maxBytes` or when the browser runs
> low on room. Fetching linked records by key, and holding less than a
> collection, are planned in
> [spec 05 §9.1](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

## Following the account

With the account key, a node keeps its spaces in step with the account's
list in the account registry. Join a space on your phone, and your laptop
joins it too.

The node's own `registry` store lists each space it holds: its keys, an
invite secret while one waits to be used, the account's place there as last
seen, the relays the space names, and, for an app without the account key,
its member key.

Three kinds of space are the account's own machinery, and `spaces.list`
hides them:

| Space                | Derived from                               | Notes                                                                  |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| The account registry | the account key                            | Opened directly. Can't be left.                                        |
| The contacts space   | the account key, or `config.contactsSpace` | In the node's registry, so it can be granted to an app. Can't be left. |
| Carry spaces         | the account key and the carrier's key      | Opened directly. Can't be left.                                        |

### Reconciling

At start, and whenever the account registry changes, the node reconciles,
one run at a time:

1. It joins every space a `sys.joined` record names that it doesn't hold,
   with the view-only invite in the record.
2. It leaves every space whose `sys.joined` record was deleted, all at once.
   The space leaves the list right away. If the account still holds a place
   there, giving it up runs in the background, as [leaving](#leaving-a-space)
   describes.
3. It writes a `sys.joined` record for a space it holds that the registry
   doesn't know.
4. It brings every carrier's passes and wakes up to date.
5. It names the account's carriers as keepers of the open spaces it manages.
6. It asks each host the account uses how it stands, without waiting, and
   hands it the spaces if it was paid ([hosting](#carriers-hosting-and-notifications)).

Creating or joining a space writes its `sys.joined` record. Leaving deletes it.

### Profiles

The node publishes the account's profile, `{ name, contactKey? }`, in a space
when it opens, when the account takes a place there, and when the name
changes on any device. The name comes from the registry's `sys.profile`
record, and `contactKey` is included only when the node holds it. It skips
the account registry and the contacts space, an account with no name, and
any note without `/account/write`, such as an agent's.

### Joining

`spaces.join(invite)` takes a bare invite, or any link with `#invite=…`,
`?invite=…` or `&invite=…`. A short link is fetched from its mailboxes first
([invites](spaces.md#invites)). It stores the space and its key, and
`memberKey` when given, writes the `sys.joined` record, then uses the
invite's role secret. If the space's invite record hasn't arrived yet, the
space shows `joining: true`, and the node tries again each time records
arrive.
[Spec 06 §1.3](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## Events

`node.subscribe(listener)` tells you what happens, and returns a function to
stop. A listener that throws doesn't stop the others.

```ts
const stop = node.subscribe((event) => {
  if (event.type === 'records') console.log('changed in', event.space);
});
```

Each event is a [`NodeEvent`](https://minca.dev/api/core/type-aliases/NodeEvent/), told
apart by its `type`: records changed, status, the list of spaces, the account,
a refused version, a live message, a revoked note, or the network.

A `status` change in the account registry is sent for every open space too,
since that is where the node learns which peers are the account's own.

### Versions that wait or are refused

A version from a peer stands, waits or is refused. What the node does with
each:

- A batch is taken in `sys.collection` versions first, then by `seq`, so
  what others depend on is in first and little has to wait.
- A version that waits is held in memory, at most 1,000, oldest dropped
  first, and judged again whenever something new is stored. One waiting for
  an earlier version asks the peer for it at once.
- A withdrawn version, allowed when written but taken away by a removal or a
  revoke it hadn't seen, is stored and passed on. It sends no `rejected`
  event and never shows as a record. It is kept for proofs that cite it
  ([spec 09 §6](https://github.com/leifriksheim/minca/blob/main/spec/09-contracts.md)).
- A version that breaks its collection's [contract](contracts.md) is also
  stored and passed on, with no `rejected` event, and `records.get` and
  queries skip it.
- A refused version sends a `rejected` event and is remembered by peer and
  id, at most 10,000, so it isn't asked of that peer again. Never by id
  alone: a copy with a mangled signature has the real version's id.

[Spec 02 §9.5](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

## Live messages and status

`spaces.send(id, message, to?)` sends any JSON value to the peers connected
in the space right now. It isn't stored or signed. Use it for things like
"typing…" or a cursor.

```ts
await node.spaces.send(space.id, { typing: true });
```

- The message, as JSON, can be at most 65,536 characters. Longer throws
  "A live message can be at most 64 KB".
- It goes once to each connected peer, over whichever network it last used.
- With `to`, it goes only to the peer with that session DID (one device), or
  to every device of the account with that DID. A peer whose account isn't
  checked yet is matched by session DID only.
- In a private space, nothing goes to someone removed or who left, and
  nothing from them arrives.
- An agent's node refuses `send`.

Each peer may send a burst of 60, then 20 a second.

A message that arrives is a `message` [event](https://minca.dev/api/core/type-aliases/NodeEvent/),
with the value sent, the sender's account and the device it came from.

[Spec 04 §9](https://github.com/leifriksheim/minca/blob/main/spec/04-network.md).

### Status

`spaces.status(id)` tells you how a space is connected, as a
[`SpaceStatus`](https://minca.dev/api/core/interfaces/SpaceStatus/): its connection, the peers
connected and whose they are, a fingerprint of what it holds, and what it
holds and still has pending.

`connection` is `offline` with no network, and `connected` while any one
relay socket or peer is. A space whose relays all drop and whose peers leave
goes back to `connecting`. It is `error` only when the first connect failed
and nothing has connected since.

A peer's key doesn't say whose it is. But only the account's own devices and
apps can read its registry, so a peer there is one of ours. That is how `own`
is worked out.

## The rest of the node's surface

Every value a node method returns can be turned into JSON. So the same calls
work over a command line, MCP and WebMCP ([actions](actions.md)).

### Spaces

`node.spaces` creates, invites, previews, joins and leaves spaces, and
manages who is in them: `access`, `may`, `holdsRole`, `defineRole`, `assign`,
`unassign`, `removeMember`, `stepDown`, `succeed`, `closeInvite`,
`changeKey`, `setRelays`, `setKeepers`, `revoke`, `profiles` and
`authenticator` ([spaces](spaces.md)).

An invite is for `member` when the inviter may give that role. Otherwise it's
for the first role by name the inviter may give, or view-only with none
([invites](spaces.md#invites)).

- `access(id)` gives a [`SpaceAccess`](https://minca.dev/api/core/interfaces/SpaceAccess/):
  the roles with their current definitions, the members, invites, founders,
  successors, keepers and more
  ([the top and founders](permissions.md#the-top-and-founders)).
- `may(id, cmd, args?, account?)` asks whether an account may run a command
  with these arguments now. Apps use it to show what someone can do. Peers
  still judge each version on its own.
- `holdsRole(id, role, account?)` asks whether an account holds every grant a
  role gives, each as wide or wider. It compares the words only, so it may
  say no where the policies would allow, but never yes where they wouldn't.
  Apps use it before giving a bot a role.
- `defineRole(id, { name, title?, grants, nests? })` writes a role. It can
  hold only what this account could do itself.
- `assign(id, did, role)` and `unassign(id, did, role)` give and take a role.
  Taking your own needs no grant. `removeMember(id, did)` removes an account
  with all its roles, and removing yourself is leaving. Taking power away
  writes a cutoff at what this node holds of theirs.

[Spec 03](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md).

### Revokes

`spaces.revoke(space, key, { waitMs? })` and `account.revoke(key, { waitMs? })`
resolve once the revoke is written. With `waitMs`, they wait until a peer has
taken it in or that time has passed, and say `true` when one did. With no
network, that is `false` at once. A node about to stop should wait like
this, since it sends nothing afterwards.

### Records and the account

- `node.records` and `node.collections` read and write records
  ([records and queries](records-and-queries.md), [collections](collections.md)).
  `records.watch` runs a query again after each `records` event for its
  space, one run at a time, with at most one more queued.
- `node.account` needs the account key. `profile()` reads the profile.
  `setName(name)` writes it to the registry, then publishes it in every open
  space. `setAvatar({ bytes, mime } | null, { name? })` and `picture()` do the
  same for the account's picture ([spaces](spaces.md)). `revoke` revokes one
  of the account's keys in the registry.
- `account.space()` is the registry's id. Keep what is the person's own
  across their devices there, like an app's settings: define a collection of
  yours and write records, as in any space. Every device of the account and
  every app given the whole account reads them. Writing there needs the
  whole account's write access: what an agent writes there counts for
  nothing. Keep it small, settings and not files or lists that grow: every
  device holds the registry whole, and carriers carry it. Leave the `sys.*`
  records alone, and give a collection one definition, shared by every app
  that uses it. An app given only some spaces has no registry: it keeps its
  settings in a space it was given, or on the device.
- `node.contacts` ([contacts](contacts.md)). `ask` and `accept` make a space
  for two, so they need whole-account access (`/account/write`).
- `node.direct` ([direct messages](direct-messages.md)): `reachable`, `send`
  and `list`. It needs the account's member key for the space.
- `node.inbox` ([the inbox](#the-inbox)) needs the contact key. Knocking and
  accepting also need whole-account access.
- `node.carriers`, `node.hosting` and `node.notifications`
  ([carriers and hosting](#carriers-hosting-and-notifications)).

### The network and agents

- `node.iceServers()` gives the ICE servers for your own connections, such as
  [calls](../../calls/README.md#connections) ([the network](#the-network)).
- `node.network.status()` shows each relay's state, the connections open and
  being made, and whether a relay offered TURN. `reconnect()` redials a
  waiting relay now. A `network` event follows each change. This is local
  only.
- `node.asAgent({ keys, note })` ([acting as an agent](#a-node-acting-as-an-agent)).

## The network

How this node uses relays, always-on nodes and WebRTC. Another
implementation may pick other numbers and still talk to this one
([spec 04](https://github.com/leifriksheim/minca/blob/main/spec/04-network.md)).

### Relays

Network settings can mix kinds of relay:

```ts
import type { NodeNetworkConfig } from '@minca/core';

const network: NodeNetworkConfig = {
  relays: ['wss://relay.minca.social', 'nostr+wss://relay.damus.io'],
};
```

A relay of a kind the library doesn't speak is left out of
`network.status()`. On a Nostr relay, each event is signed with a throwaway
key.

When a relay drops, the node redials after 1, 2, 4, 8 and 16 seconds, then
every 30, each ±25% so peers that dropped together don't return together. It
never stops until `disconnect`. It tries at once when the page becomes
visible, when the browser reports `online`, and on `reconnect()`. A
successful open resets the count.

A socket can die without closing, as it does when the device sleeps. So the
node checks the clock every 5 seconds, and a gap over 30 seconds means it
slept: it drops the socket and dials again. A socket to a Minca relay that
has heard nothing for 30 seconds sends `ping`. Once the relay has answered
one, two unanswered pings end the socket ("The relay stopped answering.").

Each relay's state is a [`RelayStatus`](https://minca.dev/api/core/interfaces/RelayStatus/):
connecting, open, waiting to try again (with when and why), or stopped.

A socket opened only for a space's own relays closes once no space needs it.
A node that may change a space's relays (`/space/relays`), in a space that
names none, names its own relays there, up to 8.

### Meeting peers

A node says hello in each space's room when it joins, on each relay as it
opens, and every 2 minutes.

- It says hello back at most once every 10 seconds, to everyone who said
  hello meanwhile.
- It remembers, per room, the hellos it acted on from each peer in the last 2
  minutes (up to 256 a peer), and failed tries for the last 512 peers.
- Each socket sends at most 20 messages a second, in bursts of 40, and queues
  the rest.
- A connection attempt that times out is tried again at the peer's next
  hello.
- Each WebRTC offer or answer waits up to 2 seconds for ICE gathering.

### Connections

- A connection no room takes up within 10 seconds is closed.
- An attempt gets 20 seconds, doubling with each failure at the same peer, up
  to 5 minutes.
- The node remembers the last 512 signals it relayed, by their signatures.
- A node that must prove read access but holds no read key fails the
  handshake, and the room times out.

### Always-on nodes

`network.nodes` lists nodes to dial, one socket per node per space. After an
unexpected close the node redials forever, waiting `min(1 s · 2ⁿ, 30 s)`,
±25%, like a relay. A deliberate close is never redialled. The node's `/peer`
endpoint waits 10 seconds for the hello.

### In-process links

`createLocalHub()` links every transport made from it, delivering bytes on a
later task, copied, as on a real wire. There is no handshake. A carrier uses
it to keep its copy of a space level with the copy in the person's pod folder.

### ICE servers

The default ICE servers are STUN only, `stun:stun.l.google.com:19302` and
`stun:stun1.l.google.com:19302`. `network.iceServers` replaces them. Each new
WebRTC connection also uses the TURN servers relays offered, while they
haven't expired.

`node.iceServers()` returns the same list, for your own connections. If a
relay is connected and the TURN passwords are missing or expire within 10
minutes, it first asks each relay that can, at most once every 10 minutes,
and waits up to 1.5 seconds. With no relays, it returns the configured
servers.

## A node acting as an agent

An agent writes for a person, but only records, and only where it was let in.
`node.asAgent({ keys, note })` gives you the same node acting as one:

```ts
import type { Delegation } from '@minca/core';
declare const keys: CryptoKeyPair;
declare const note: Delegation;
// ---cut---
const agent = await node.asAgent({ keys, note });
await agent.records.put(space.id, 'app.note', { text: 'Written by the agent' });
```

It throws unless the note verifies, grants records only (under `/record`), is
made out to `keys`, and was issued by `node.did`. The agent:

- signs with its own key under its note, so what it writes is `recordsOnly`;
- reaches only the spaces its note names, or every space for a note about
  the whole account, and hears no events from others;
- sees the contact list only if its note covers the contacts space.

It refuses everything that needs a person: making, inviting, joining or
leaving spaces; changing members, roles, invites, revokes, keys, relays or
keepers; defining or deleting collections; live messages, which a person's
devices would take as theirs; renaming or revoking at the account level;
carriers, notifications and hosting; contacts and the inbox; `delegate` and
`asAgent`.

Closing the agent leaves the node running. A node used across a port
(`remoteNode`) starts no agent, since the agent's keys would have to cross.

An agent granted `scope: account` gets a records-only note for every space,
and the account key, so it can read the contact list. A home never gives a
records-only key the contact key, which would open the account's knocks
([the inbox](inbox.md)).

One table in the library says which methods an agent passes through, limits
to its spaces or refuses, and what `remoteNode` forwards. A new method
doesn't type-check until it's listed there.
[Spec 06 §2.8](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## The app-side client

An app connects to an account home with `createMincaConnection`
([building an app](building-an-app.md)). These are the pieces underneath.
[Spec 06 §2](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)
says what the app and the home send each other.

### The app's key

`appKey(name = 'default')` makes the app's P-256 key once and keeps it,
non-extractable, in the IndexedDB database `minca-app-key`, store `keys`,
under `name`. `forgetAppKey` deletes it, and the next connection makes a new
one.

### An app's node outside the page

The desktop app runs its app's node in a process of its own,
`minca app-node`, so it keeps running with the window closed. The window
talks to it over a WebSocket to the shell's server, which opens only for the
app's window, with a token made for it. One process holds the key, so the
window and the menu bar share one node. A lock on the folder stops a second
one, since two nodes signing with one key would fork its lines.

Its key and grant rest in its folder as `key.sealed` and `grant.sealed`
(labels `minca/desktop-app-key/v1` and `minca/desktop-grant/v1`, bound to
`{ file }`), sealed under a key the shell keeps in the system keychain. Its
registry is sealed as an account's is. Copied without the keychain, the
folder gives up no key, grant or private body. A program running as the
person can still ask the keychain, as it could read a browser profile. A
folder that doesn't open with the keychain's key is moved aside, and the node
starts again unconnected.

- There's one folder of stores per account. Connecting as another account
  deletes the last one's.
- Renewing keeps the key. Disconnecting, from the app or the home, forgets it,
  so a revoked key stays revoked.
- If the home answers as a different account, the app leaves the last one,
  dropping what no peer had taken yet, and asks again with a new key. One key
  never holds two accounts' notes.
- The window sees the grant without its account, contact or member keys.
- It asks the home for a 30-day note, where a page asks for the home's
  default.

### The home's address

`homeAddress(input)` turns what a person typed into the home's connect page:

```ts
import { homeAddress } from '@minca/core/session';

homeAddress('minca.example.com'); // 'https://minca.example.com/connect'
```

- With no scheme it adds `https://`, or `http://` for `localhost`,
  `127.0.0.1` and `[::1]`.
- The host must be a loopback name, or a domain with a TLD of two letters or
  more.
- The scheme must be `https:`, or `http:` on loopback.
- An empty path or `/` becomes `/connect`. Query and fragment are dropped.

### Asking the home

`connectToHome`, and `proposeToHome` for a proposal, open the home in a popup
named `minca-home` (`popup,width=460,height=720`). They send the request to
the home's origin only, every 500 ms, until the home answers. They check every
500 ms whether the person closed the popup, and give up after 10 minutes by
default.

### Starting the node

[`startConnectedNode`](https://minca.dev/api/session/functions/startConnectedNode/) starts a
node with:

- `signer`: `grantSigner(grant)`, so `did` is `grant.did`;
- `sessionKey`: the app's key;
- stores: `indexedDBStores('minca-app:<grant.did>')` unless given;
- `cache: {}` unless `cache: false`;
- `accountKey`, `contactKey` and `contactsSpace` from the grant when there,
  never `contactKey` under a records-only note;
- relays: the app's plus `grant.relays`.

It then joins each granted space it doesn't hold yet, with its `memberKey`.
The desktop app's node and the agent on a computer start the same way, from
their own folders.

### The connection

`createMincaConnection(config)` is the app's version of [sign-in](sign-in.md).
It takes a [`MincaConnectionConfig`](https://minca.dev/api/session/interfaces/MincaConnectionConfig/),
and its status is a [`ConnectionStatus`](https://minca.dev/api/session/type-aliases/ConnectionStatus/).

- With `worker`, the node runs in a worker. If the worker fails to load or
  doesn't start the node within 30 seconds (`WorkerNotStarted`), the node runs
  in the page instead. A worker that started and refused passes its reason on.
- It turns `expired` when the grant's `expiresAt` passes.
- When the node sees its note revoked (`revoked`), the connection forgets that
  account's grant and key.
- `propose(automations)` sends a proposal to the grant's home.

### Several accounts

A person can connect more than one account. The connection keeps a grant for
each and acts for one at a time. `state.accounts` lists them as
[`ConnectedAccount`](https://minca.dev/api/session/interfaces/ConnectedAccount/)s, in the order
first connected.

- `start()` acts for the account `account(accounts)` picks, else the one used
  last, else the first.
- `use(did)` switches to another connected account without asking the home.
  The old node closes, and one for this account starts, with its own stores.
- `connect(home?)` asks with a new key, for whichever account the person
  picks at the home: a new one, or one already connected, whose grant it
  renews. No key is ever used to ask twice, since a key that asked once may
  hold a note from any account the home was signed in as. The renewed account
  gets the new key and the old one is forgotten. The home revokes nothing, and
  what the old key wrote stands.
- While `connect` waits, an app acting for an account stays `ready`. A grant
  whose node won't start is kept, and the status is `disconnected` with why.
- `disconnect(did?)` forgets an account's grant and key, by default the
  current one, and acts for the next account, or none. Disconnected at the
  home instead, it acts for none, with `error` saying why.

Each grant is made out to a key of its own, `account-<uuid>` in `appKey`'s
store (or `keys`), so peers never see one key act for two accounts. Grants
live in `localStorage` under `minca.grants` (`[{ grant, keyName }]`), the
current account under `minca.account`, and the chosen home under `minca.home`
(the config's `home` is only a default). A grant whose `v` isn't
`GRANT_VERSION` (2) is dropped. An expired one stays, and opens as `expired`.

Each tab acts for its own account, and sees other tabs' changes to
`state.accounts`. A tab whose account was connected again elsewhere keeps
its key until it restarts, then takes the newer grant. One whose key was
revoked takes up a newer grant rather than forgetting it. A shared worker
runs a node per key. Switching again before a node has started closes it.
[Spec 06 §2.10](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

### Showing notifications

An app shows its own notifications with
`watchNotifications(node, { origin?, onNotify })`. It needs the account key,
so an app with `scope: account`. It reads the account's automations for the
app's origin, and calls `onNotify({ automation, record })` for each record
that arrives matching one.

A record matches when the automation isn't paused, and the record is in its
collection and one of its spaces, created after `since` and within the last
24 hours, by another account when `others` is set, and its `where` holds,
with `$me` the account. What the node held before it started is never news,
and nor is what a collection held when an automation first looked there.

How to show a match is up to the app. A "Notify me" button is usually where a
proposal starts.

For a list of what happened, pass `onActivity` too. After each change it gets
what the automations match now, newest first, up to 50, each record once under
the automation that asks about it most particularly. A match is dated by what
set it off, and listed if it would have notified when that was written, so
the 24 hours don't apply. It comes from the records, so it holds what arrived
while the app was closed, and devices holding the same records list the same.
Like notifications, it looks at the newest 50 records of a collection, by the
time their writers gave them, so an older match drops out under newer ones. A
match dated more than five minutes ahead waits for its time.

```js
watchNotifications(node, {
  onNotify: ({ automation, record }) => showPopup(automation, record),
  onActivity: (matches) => setActivity(matches),
});
```

What the person has read of it is the app's to keep: a time in the account
registry, say, and what is newer counts as new. A record that arrives late,
dated before that time, then isn't new, though it still notifies within its
24 hours.

## Carriers, hosting and notifications

A carrier is an always-on node that keeps the account's spaces online while
its devices are off. A host runs carriers for you, for a fee or for free.
[Spec 06 §4](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)
and [spec 08](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md)
cover what goes over the wire.

### Carriers

`node.carriers.add({ did, name })` needs the account key. It derives the
carry space, writes the `sys.carrier` record, fills the carry space, and
returns `{ space, invite }` for the carrier to join with. The name is trimmed
to 80 characters, `Carrier` by default. Adding a carrier it already has
returns that one.

Carry spaces aren't kept in the node's list. Each is derived again from its
record. When the node starts, or the registry changes, it refills every carry
space in the background. That opens every space the account holds, which is
slow from a data folder, so signing in doesn't wait for it, and nor does
adding an automation. Adding a carrier writes its passes before it returns.

- `carriers.settled(waitMs)` waits for the refill under way, and says whether
  it finished. Use it before a window closes.
- `carriers.reached(carrySpace, waitMs)` waits until the node is level with
  the carrier in the carry space and the account registry. A node about to
  close waits on it, so what it wrote for the carrier isn't lost.
- `carriers.remove(carrySpace)` writes `carry:closed` and marks the record
  removed. The carry space stays open until the node closes, so the carrier
  hears it.

### A space made just now

A new space lives only on the device that made it until a carrier syncs it.
An invite handed out before then, with the device closed, can't be used.

`node.spaces.carried(spaceId, { waitMs? })` is a short loading step for that.
If a carrier of the account is connected, it names it a keeper, writes its
pass, and waits up to `waitMs` (default 3 seconds) for it to be level. It
says whether it was, and is `false` at once with no carrier connected.
`contacts.ask` and `inbox.knock` wait on it, and return what it said as
`carried`, so the app can tell the person.

`node.spaces.reached(spaceId, peer, waitMs)` waits the same way for one peer,
named by its key, such as an app's key. It is `true` once that peer holds
everything this node does, and `false` when `waitMs` (at most a minute)
passed first. A connect page uses it to wait for the app to have what it
wrote.

### The account's own automations

`node.automations` needs the account key. It lists, adds, updates (`name`,
`paused`) and removes the account's own
[automations](automations.md#the-accounts-own), kept in its registry, and
copies a wake for each into every carry space. The reference home adds them
when a person keeps an app's proposal, and lists them by app to pause or
remove ([the account home's side](sign-in.md#the-account-homes-side)).

### A carrier's matches

When a version wakes one of the account's wakes, a `CarrierNode` sends a
`wake` event with only the wake, the space, and the record's key, collection
and `createdAt`. `wakes()` lists the wakes it holds. The browser extension
shows these as notifications.

### Hosting

`node.hosting` pays a host and hands it the account's spaces. Its calls are
on [`NodeHosting`](https://minca.dev/api/core/interfaces/NodeHosting/): start and stop using a
host, pay into the account's balance or a space's own fund, ask for reminders,
see how each host stands, and start a bot.

A few details:

- `list()` makes the carrier first if needed, named after the host's address.
  A second call waits for a handover already in flight. Every device runs it
  after each [reconcile](#following-the-account).
- `pay` and `payForSpace` take `method` `checkout` or `request`, and
  `monthly` by card, as the host's `HostingView.fund` offers. They answer
  with `checkout`, a page to open in a new tab with no opener, or `request`,
  a payment for a wallet that the app shows. Call `list()` until the balance
  moves.
- `remind` mails a link to confirm first.
- `stop` sends `DELETE …/carry`, ignoring failure, removes the carrier and
  deletes the `sys.hosting` record.
- `over(id)` returns `{ url, name, over }` with `over.until` and
  `over.reasons`, read from the receipts in `sys.hosting`. It asks no host.
  An agent may call it for a space it was given.
- `startBot` makes an invite for `role` (by default as `spaces.invite` picks)
  and hands it over. The host holds the bot's keys, so tell the person first.
  [Spec 08 §3](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md).

### Reaching hosts

A device reaches a host at the socket its description names (`peer`). Every
open space holds a socket to each host in `sys.hosting`, and to each host the
space names in `std.host`, and follows as those change. `network.nodes` adds
sockets of its own, to every space.

`network.hosts` names hosts to look for the account registry at, before the
account says which it uses. An app with a default host can then restore an
account from its recovery code alone.

`network.reach(address)` decides whether the node may connect to an address
it found rather than was given: a host or node a record or invite names, a
relay a space or invite names, a short link's place, a host it asks to
describe itself. Its own `relays`, `nodes` and `hosts` are always allowed,
and without `reach`, so is everything. A refused host isn't asked, so
`hosting` calls fail. A refused node or relay isn't dialled. Use it for a node
a server runs for someone else, such as the MCP service's: what that node
reads isn't the server's to trust, and must not make it connect inside its
own network.

A device waits 15 seconds for a host to answer, and a minute for `startBot`.
No answer in time is a `HostError` with status 0, whose message names the
address. `describeHost(url, timeoutMs?)` takes another limit. `list()` and
`space(id)` don't throw it. They return that host's view with `error` set,
so one host that is down doesn't hide the others.

### The reference host

`minca host` makes these choices of its own:

- A lapsed subscription is kept for `graceDays` (default 30) after
  `paidUntil`, and swept out hourly (`sweepMs`).
- It measures each carried space's folder at most every ten minutes. Each
  status gives the total as `bytes`, and `quota` from `MINCA_HOST_QUOTA_GB`
  (none unless set).
- At its quota, an account's carry space takes no new space (`full`). What it
  carries stays and keeps syncing, and a space that waited is taken once
  there's room.

With `limits` (`MINCA_HOST_FREE_GB`), a subscription is active with nothing
paid, on the `free` plan until it pays, with its quota by plan. A device
hands such a host its carry space as it would a free one. A space paid for by
its own fund takes none of its members' room. The host counts each space's
writers as versions arrive (`onArrived`) and its readers as sockets prove
themselves (`onPeer`), and once an hour (`evaluate`) holds each space to the
free line. Past a space's `until`, every account's carry space stops carrying
it (`skip`), while the space's own subscription still may. Each change is a
line in the host's log.
[Spec 08 §1.1](https://github.com/leifriksheim/minca/blob/main/spec/08-hosting.md).

### A space paying for itself

A community can pay for its own hosting. It names its hosts in `std.host`
records ([standard library](standard-library.md)), which only members granted
it may write. The `community` template leaves `std.host` to admins and
moderators (`STAFF_COLLECTIONS`). The host then keeps the space under a
subscription of its own, `space:<id>`, with a fund anyone can add to. The
fund pays for keeping it online and for its bots.

Every device holding the space's key looks at the hosts the space names: when
it takes a role there, at once when the hosts change, and otherwise at most
every ten minutes. Agents and carriers don't. For each host it reads the
description, refuses one whose key isn't the one the record names, asks for
the status, and hands over the space's pass when the host is paid (or free
and not lapsed) and doesn't carry the space yet, or carries it with an older
read key. It looks only where the space defines `std.host`, so a space held
in part isn't made to hold it.

`node.hosting.space(id)` does the same at once, and returns each host's view:
its name, key, status (the fund's `balance`, its `daily` spend and the `bots`
running), whether it is `free`, and `fund`, how money goes in. Show `fund` to
anyone who wants to chip in, and pay with `payForSpace`. A host with neither
`free` nor `fund` takes no communities. A host that couldn't be asked has
`error` and no status. An agent may call `space` for a space it was given,
but paying is a person's.

`node.hosting.stopForSpace(id, url)` stops a space using a host. It asks the
host which bots it runs there, deletes the `std.host` record first so no
device hands the host anything new, removes those bots, and gives a private
space a new key if the host had it, or can't be asked. Removing a bot
changes the key by itself. With no bot removed, it calls `changeKey`. It
answers `{ bots, newKey }`.

It removes a bot only where the account may run `/member/remove` on it, and
changes the key only with `/key/change`. Without either, only the record
goes, and the answer is `{ bots: [], newKey: false }`. A host that was named
but never handed the space costs no key change.

No call asks the host to drop what it has. It keeps the space, unreadable,
for as long as the space's subscription is paid, and the fund keeps its money
([#220](https://github.com/leifriksheim/minca/issues/220)).

## The inbox

The inbox is where strangers knock to start a conversation, using a code, a
link or a username. `node.inbox` needs the contact key
([inbox](inbox.md), [spec 07](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md)).

Its calls are on [`NodeInbox`](https://minca.dev/api/core/interfaces/NodeInbox/): open,
rotate and clear the inbox, claim a username, knock, and list, accept or
dismiss the knocks that arrive. `get()` returns an
[`InboxView`](https://minca.dev/api/core/interfaces/InboxView/), with the code to hand out.

A username follows the inbox. `rotate` and `open` point it at the new code,
and `knocks` renews it a month before it lapses. You hold one at a time.

`knocks()` fetches the inbox from every mailbox it names, opens and checks
each knock (caching the results by id), and settles knocks you sent. Each is
a [`KnockView`](https://minca.dev/api/core/interfaces/KnockView/). Knocking and accepting both follow
[the exchange](inbox.md#the-exchange), and need whole-account access.
[Spec 07 §6](https://github.com/leifriksheim/minca/blob/main/spec/07-inbox.md).

## Client conveniences

These aren't protocol. Another client may draw sign-in and
[calls](../../calls/README.md) however it likes.

Sign-in has no drawn screens in the library: a page draws its own on
[`createMincaAuth`](sign-in.md), as the account home does.

## React

`@minca/react` follows sign-in or the connection, and keeps what you read
live. `MincaProvider` goes at the top, given an `auth` or a `connection`;
`useMinca`, `useAuth`, `useSession`, `useConnection` and `useAccount` read
it. Below it, hooks such as `useNode`,
`useSpaces`, `useQuery`, `useRecord` and `useCan` read and keep current what
you show, with `useLive` and `useWatched` for anything else. Each one, and what
it gives, is in the [React reference](https://minca.dev/api/react/).

`result.complete` is false while an app that holds only part of a space is
still fetching a collection. Show "Loading…", not "Nothing here".

An app given the whole account sees every space in it. `useSpaces({ having: [todos] })`
lists only the spaces that define those collections.

Calls have their own, `CallsProvider` and `useCalls`, in `@minca/calls/react`.
