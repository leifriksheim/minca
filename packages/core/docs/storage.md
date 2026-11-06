# Sync and storage in the library

Where a node keeps its data, and how it syncs it. You rarely need this page
to build an app. Read it to attach files to records, to know what a node keeps
on a device, or to plug in storage of your own.

## Files

Records hold small things. A photo or a document goes in a file, and a record
points to it:

```ts
declare const file: File;
// ---cut---
const bytes = new Uint8Array(await file.arrayBuffer());
const photo = await node.records.addFile(space.id, bytes, { mime: file.type, name: file.name });
await node.records.put(space.id, 'app.post', { text: 'Look', photo });
```

`addFile` encrypts the bytes under a fresh key and gives back a
[`FileRef`](https://minca.dev/api/core/interfaces/FileRef/). Put it anywhere
in a body. When the body is written, every file in it is named on the record,
at most 16.

To show it, read the bytes back:

```ts
import type { FileRef, NodeRecord } from '@minca/core';
declare const post: NodeRecord<{ text: string; photo: FileRef }>;
declare const img: HTMLImageElement;
// ---cut---
if (post.body) {
  const { photo } = post.body;
  const bytes = await node.records.readFile(space.id, photo);
  img.src = URL.createObjectURL(new Blob([bytes.slice()], { type: photo.mime }));
}
```

`readFile` gives the bytes if they're here. Otherwise it fetches them from
connected peers, one after another, then from mirrors, checking every chunk.
When nobody has them, it waits. It asks again whenever records change or a
peer connects, and every 15 s, and resolves once someone does.

It rejects for a file no record here names, for one that won't open as named,
and when the space closes.

### What a device keeps

Files follow records. About 2 s after records change, a node fetches the
files they name, while the writer is likely still connected. A file nobody
had is not asked of everyone again for 10 minutes, but is asked at once of
each peer that connects.

A device limits the files it didn't add, per space:

- It fetches unread only files up to 5 MiB. So photos and documents come
  ahead of time, and video when played.
- Past 256 MiB of files in a space, it drops those fetched or opened longest
  ago, down to 90%. A file never fetched whole goes first.
- It never drops a file added here, or one being fetched or read. A file
  larger than the limit is dropped after it is read, and fetched again at the
  next read.
- A dropped file that was whole is not fetched again unread while a record
  names it. Reading it fetches it.

Because the limit is per space, a device in many spaces holds more. A node
with `fetchFiles: 'all'`, such as a carrier or host, fetches and keeps every
file.

A person can choose other limits for their device, such as fewer downloads on
a phone. Give them to the node each time it starts, since it keeps none:

```ts
// Only thumbnails and other small files come ahead; up to 1 GiB kept per space.
await node.setFileLimits({ ahead: 256 * 1024, keep: 1024 * 1024 * 1024 });
```

`Infinity` fetches or keeps everything. New limits take effect in every
open space within a few seconds: past `keep`, files go at once, and raising
`ahead` fetches what now fits. A file dropped earlier still waits until it is
read. Pictures and videos carry a small `thumbnail` (see the
[standard library](standard-library.md)) so that a device fetching only
small files still shows them.

About 2 s after records change, files no record names are dropped. A file
added here in the last 24 hours, and not yet named, is kept. Files of
records that don't stand are not kept.

### How files are served and stored

- A peer answers a request for a file with at most 4 chunks at a time, so a
  large file never floods a connection.
- Chunks are entries in the space's own store: `f/<id>/list`, `f/<id>/<n>`,
  `f/<id>/own` (when it was added here, 0 once a record names it) and
  `f/<id>/used` (when it was last fetched or read). A data folder keeps these
  in this device's own stores, not the folder.
- Each file a node holds whole goes to its mirrors, with its chunk list,
  under `files/<space>/<store writer>/`. Files no longer named are deleted
  there.

What peers must agree on, from chunks to encryption, is in
[spec 05 §16.6](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

### Planned: video and pictures

> **Planned:** not normative.
>
> - **Video.** Play before the file is whole, through a service worker that
>   answers the browser's range requests from the chunks read so far. MP4 with
>   its index first, or WebM. A poster is a second, small image.
> - **Several peers at once.** Ask chunks of several peers in parallel.
> - **Mirrors by range.** Read one chunk from a mirror without the whole file.
> - **Pictures.** `std.image` gains `width`, `height` and a tiny placeholder
>   shown before the picture arrives. `std.profile`'s `avatar` is resized in
>   the browser before it is added.

## IndexedDB

In the browser, a node keeps each store in its own IndexedDB database,
through `indexedDBStores(prefix)`. The database is named
`<prefix>:<path>`, with `/` in the path turned into `:`. Only this site can
read them.

| Who                                 | Prefix                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| An account signed in in the browser | `minca:<dataPath>`, as `minca:accounts:k3x9q2:stores:spaces:<space id>` |
| An app connected to an account home | `minca-app:<account DID>`                                               |
| A data folder's own stores          | `minca-pod:<dataPath>`                                                  |

A data folder uses `minca-pod:`, not `minca:`, because `minca:` is deleted
when the person forgets an account's browser copy.

Each database is version 4. Opening one made at an earlier version empties
it. Space records come back by syncing, but the registry is lost with it:
space keys, unused invites, and anything written here and not yet synced.
That is accepted before v1. After it, a change must keep the registry.

Inside each database:

- Object store `kv` holds entries: string keys, `ArrayBuffer` values.
  `list(prefix)` is a key-range cursor over `[prefix, prefix + "￿"]`.
- Object store `versions` holds version bodies, keyed by `id`.
- `batch` is one `readwrite` transaction over `kv`. Bodies get their own
  transactions, except through `commit`, which is one transaction over both.
- `entries(prefix)` and `getVersions` each read in one `readonly`
  transaction.

Other databases:

| Database            | Object store | Holds                                                               |
| ------------------- | ------------ | ------------------------------------------------------------------- |
| `minca-accounts`    | `accounts`   | Accounts kept in the browser ([sign-in](sign-in.md#account-stores)) |
| `minca-folder`      | `handles`    | The remembered data folder, under key `data-folder`                 |
| `minca-device-keys` | `keys`       | Device keys ([sign-in](sign-in.md#device-keys-and-passkeys))        |

A host keeps its subscriptions in its own store, path `host`, under keys
`subscription:<id>`
([spec 06](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

## Data folders

A data folder, or pod, is the whole account in a folder. Copy it to a USB
stick and you have all of it. Put it in iCloud, Dropbox or Syncthing, and
several devices converge with no relay, since records only ever add up.

`folderStores(directory, { basePath, localKey, local })` gives a node its
stores for one:

- The `registry` lives in the folder, one file per entry, sealed under
  `localKey`.
- Each space lives in the folder as segments, under `<basePath>/spaces/`.
  The node mirrors to them ([mirrors](#mirrors)). It pulls when a space opens
  and every `watchIntervalMs` (default 2 s, `0` turns it off), and pushes 1 s
  after a change and on close.
- Everything else goes in `local`, this device's own stores.

Each device adds a folder of segments per space, about one file per 256 KiB
of records. It compacts them once it has 32, and twice what the last
compaction left.

### This device's stores

`local` is where:

- **In the browser**, IndexedDB under `minca-pod:<dataPath>`, by default.
- **The CLI** keeps it outside the folder, since the folder may be one a
  browser or a sync service also uses. It is `$MINCA_LOCAL`, or
  `~/.local/state/minca`, then `<first 16 hex of SHA-256 of the home's
path>/<account id>/stores`. A
  command and the daemon share it, and the daemon finds the command's writes
  (`reconcileFolder`). Writer keys are beside it in `writer-keys/`. Older
  slots left in the home, and `writers/`, are not read, so two versions of
  minca never sign with one key. `minca agent` and the commands an agent runs
  keep each session's key and stores in a slot of `<home>/agent`
  ([actions](actions.md#the-agent-on-a-computer)).
- **Elsewhere** you must pass one. `folderStores` refuses to start without
  it, since a key's state kept only in memory would be reused after a
  restart.

Two folders holding the same account, such as a copy or a restored backup,
share this device's local stores. So a version known to be in one is not
pushed to the other. Open one copy at a time, or let the other fill in from
peers.

### Getting the folder

- **In the browser** it comes from `showDirectoryPicker` with
  `id: "minca-pod"`, `mode: "readwrite"` and `startIn: "documents"`, which
  needs a click. The handle is remembered in IndexedDB. On a later visit the
  permission is checked, and asked for again only from a click. Firefox,
  Safari and mobile browsers don't have the API, and keep data in IndexedDB
  instead. A file is replaced atomically on `close()`.
- **The CLI**, in Node and Bun, writes `<name>.<uuid>.tmp` with mode `0600`
  and renames it into place. Directories get mode `0700`.

A folder is meant to be read from several sites, so it can't be OPFS, which
belongs to one.

A space kept in an older layout is not read. Peers bring it back. The
folder's layout, and how several writers converge, are in
[spec 05 §14](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

## Blob stores

A blob store keeps bytes by name. It is assumed slow, eventually consistent
and without atomic operations. A
[`BlobStore`](https://minca.dev/api/core/interfaces/BlobStore/) only gets, puts, deletes and
lists keys under a prefix.

The library has three:

- **Memory**, for tests.
- **Directory** (`createDirectoryBlobStore`), over a folder handle or a
  folder on disk. Each `/`-separated part of a key is a folder, and the last
  a file, named as a data folder names its files. A folder goes with the
  last key in it. This is what a data folder keeps its spaces in.
- **S3-compatible**: R2, B2, MinIO, Wasabi and AWS.
  - Path-style URLs, `<endpoint>/<bucket>/<prefix/><key>`, each part
    `encodeURIComponent`-ed.
  - Signed with SigV4 (`aws4fetch`). Region defaults to `auto`.
  - `list` is `ListObjectsV2` (`list-type=2`), following continuation
    tokens.
  - A 404 on `get` is null, and on `delete` is success.
  - 429 and 5xx are tried up to 5 times. It waits `Retry-After` seconds if
    given, else `min(200·2^attempt, 5000)` ms times a random factor in
    [0.75, 1.25).

## Mirrors

A mirror copies a space into a blob store, so devices that are never online
together can still meet. Today data folders, carriers and hosts mirror.

A store writer pushes 5 s after the first change, 1 s for a data folder, and
on close. It packs what the store doesn't have yet into segments of about
256 KiB. Once it has 32 or more segments of its own, and twice as many as its
last compaction left, it compacts them, keeping only what its store holds.

It keeps its state in the store `mirrors/<space id>/<n>`, where `n` is the
mirror's index:

| Key                         | Value                                   |
| --------------------------- | --------------------------------------- |
| `mirror:writer`             | The writer id                           |
| `mirror:counter`            | The segment counter, in decimal         |
| `mirror:read:<segment key>` | `1`, for each segment read or written   |
| `mirror:known:<version id>` | `1`, for each version known to be there |

"Known" is everything it uploaded or read, so nobody uploads everyone
else's versions again. It reads the `mirror:known:` entries once, when it
starts.

Segments, who may write where, pulling and compacting are protocol, in
[spec 05 §16](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

### Planned: mirrors in your own storage

> **Planned:** mirrors on any node, in storage the person already has. The
> protocol side is planned in
> [spec 05 §16.5](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

- **Any node, several mirrors.** A node takes a list of blob stores
  (`NodeConfig.mirrors`), such as the person's Dropbox and a host's bucket at
  once. It pulls when a space opens and on each change, and pushes after
  writes and on close.
- **Change feeds.** Where the service has one, pulling uses
  `BlobStore.changes` instead of listing: Dropbox `list_folder/continue`,
  Drive `changes.list`.
- **More drivers**, each passing one shared test suite, with shared backoff
  on 429 and 5xx. None ever logs a token or signed URL.
  - _Google Drive_, in one folder the app made, with `drive.file` scope only.
    Drive finds files by id, not name, so the driver keeps a map from names
    to ids. Service accounts don't work: they have no storage of their own.
  - _Dropbox_ and _OneDrive_, in their app folders. Dropbox first.
  - Not iCloud, which has no usable web API. iCloud users keep a data folder.
- **Budget.** Drive allows about 1,000 requests per 100 seconds. Segments,
  never single versions, are fetched, and syncing 1,000 records must fit.

## Storage adapters

A store runs over a [`StorageAdapter`](https://minca.dev/api/core/interfaces/StorageAdapter/).
Write one to keep a node's data somewhere new. Every method is async. It keeps
entries, string keys to bytes, and version bodies by id. A few methods are
optional.

The optional methods only save round trips. A store gives the same answers
without them, using `list` and `get`, `getVersion`, or `putVersion`, `batch`
and `deleteVersion` instead.

With `commit`, placing a version is one atomic write. Without it, versions go
first, then the entries in one batch, then the deletes. So no entry ever
names a version that isn't there.

The library's adapters are IndexedDB ([above](#indexeddb)), a directory
(`directoryStores`, for a data folder's registry and a node's stores on
disk), a sealing wrapper, and one in memory for tests.

A directory store keeps its versions and its entries' keys in memory, so a
query or a listing reads no directory. It reads the keys again when the node
reloads it. The values stay on disk, since they include file chunks. A data
folder's registry is written by every app of the account and reloaded by
none, so it reads the disk each time instead (`shared`).

Since the keys are in memory, one process writes a directory store, or the
node that has it open watches it: the daemon finds a command's writes to a
space's store when it reloads, every two seconds. Until then a key another
writer deleted is still listed, though it reads as missing.

## The store in memory

A store reads its entries once, then keeps what it needs in memory: each
collection's set of records, and the entries it read or wrote. It also keeps
up to 50,000 version bodies, letting the oldest go first. A body never
changes, so this is always safe. An entry read while a change was landing is
not kept.

When another writer changes the same store, the node reads all of it again
(`invalidate`):

- **Tabs in one browser.** Where shared workers work, the apps in this
  repository run one node for all of a site's tabs in a `SharedWorker`, one
  per account and key. Then there's nothing to tell.
- **Elsewhere** each tab runs its node in a worker of its own. Tabs tell each other through a
  `BroadcastChannel` named `minca-node:<root DID>:<space id>`. Chrome on
  Android has no shared workers, and WebKit can't use a `CryptoKey` in one,
  sent or stored. Only the tab in view runs its node, one at a time per
  account, so a frozen tab holds no store another is waiting on.
- **Writers on a shared folder** are found by reading it again
  ([data folders](#data-folders)).

The store's fingerprint, in `spaces.status`, is the Negentropy fingerprint
of every collection together, as hex. Two nodes with the same fingerprint
hold the same data.

## Pacing sync

The spec says which sync messages go, and when a peer must answer. How often
a node speaks, and how much it asks for at once, is its own choice:

| What                  | Value                              | Why                                                                                    |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Heartbeat             | a `hello` to every peer every 30 s | Finds what a lost message missed                                                       |
| Hello after taking in | about 100 ms                       | So a new version passed along doesn't wait a heartbeat at every hop                    |
| `want`s in flight     | 4 per peer (`MAX_WANTS_IN_FLIGHT`) | When one is answered, the next goes                                                    |
| Rounds per session    | 64                                 | Counted by the side that started. Past 64 the session is given up                      |
| Stale after           | 30 s                               | A silent session, or an unanswered `want`, is dropped and found again later            |
| Versions waiting      | 1,000                              | Versions held back for later wait in memory. Past 1,000 the oldest go                  |
| Refusals remembered   | 10,000                             | A refused version isn't asked of that peer again. Past 10,000 the oldest are forgotten |

The node asks first for the space's own records (`sys.*`), and for earlier
versions a waiting version needs. Everything else waits its turn. An id
already asked for is not asked again.

A session with a peer that is running and has heard something in the last
30 s isn't started again. It runs once more when it ends.

Each space reports `synced` and `level` with each peer, which
[holding part of a space](node.md#holding-part-of-a-space) uses. The page is
told records changed once per message taken in, not once per version.
