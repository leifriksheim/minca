# Sync and storage in the library

How the library paces sync, keeps a store in memory, talks to IndexedDB, a
data folder, a file on disk and a blob store, and mirrors a space into one.

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on (the sync messages, the store's entries, the data folder, sealing,
> segments) is in [spec 05](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

## Pacing sync

The spec says which sync messages go and when a peer must answer. How often a
node speaks, and how much it keeps in flight, is its own:

| What                           | Value                              | Why                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat                      | a `hello` to every peer every 30 s | Finds what a lost push or a dropped `want` missed.                                                                                                                                                  |
| Hello after taking in          | ≈100 ms                            | After something new arrives from a peer, a folder or a mirror, so a version passed along does not wait a heartbeat at every hop.                                                                    |
| `want`s in flight              | 4 per peer (`MAX_WANTS_IN_FLIGHT`) | Asking goes through a queue per peer; when a `want` is answered, the next ones go.                                                                                                                  |
| Rounds per session             | 64                                 | Only the initiator counts rounds. Past 64 the session is abandoned as runaway.                                                                                                                      |
| Session and `want` stale after | 30 s                               | A session that has heard nothing, or a `want` unanswered, for 30 s is dropped at the next heartbeat, and the next queued ones go. What a dropped `want` asked for is found again on the next round. |
| Versions waiting               | 1,000                              | Versions the gatekeeper answers _later_ wait in memory; past 1,000 the oldest give way.                                                                                                             |
| Refusals remembered            | 10,000                             | Refusals are kept per peer and id, so a refused version is not asked of that peer again; past 10,000 the oldest are forgotten.                                                                      |

The queue of ids to ask for puts the space's own records (`sys.*`) and the
first or previous versions a waiting version names at the front; everything
else joins the back. An id already queued or asked for is not queued again.

If a session for a collection with a peer is already running and has heard
something in the last 30 s, a new difference does not start another: the
running one is marked to run again once it ends.

The node reports `synced` and `level` with each peer as events inside the
space runtime; holding part of a space ([node](node.md#holding-part-of-a-space))
uses them, together with whether the peer holds `"all"`. It tells the page that
records changed once per message taken in, not once per version.

_Source: `packages/core/src/sync/sync-engine.ts` (`MAX_WANTS_IN_FLIGHT`,
`MAX_ROUNDS`, `STALE_MS`, `MAX_WAITING`, `MAX_REFUSED`, `want`, `pump`,
`sweep`), `packages/core/src/node/space-runtime.ts` (heartbeat,
`announceSoon`). Tests: `packages/core/tests/reconcile.test.ts` ("a want whose
answer is lost is given up, and the peer is synced again"),
`packages/core/tests/sync.test.ts`._

## The store in memory

A store reads its `i/` entries once, and keeps each collection's item set and
running sum in memory, updated by every change made through it. So are the
`r/` and `g/` entries it read or wrote, and up to 50,000 version bodies (the
oldest let go first): a body never changes under its id. An entry read while
a change was landing is not kept.

When another writer changed the same store, the node re-reads all of it
(`invalidate`). Other tabs of one browser are told through a
`BroadcastChannel` named `minca-node:<root DID>:<space id>`. Where a browser
has shared workers that work, the apps in this repository run one node for all
of a site's tabs in a `SharedWorker`, so those tabs share one store and have
nothing to tell each other; the channel remains for the rest (Chrome on
Android has none; WebKit drops a message to one that holds a `CryptoKey`),
where each tab's node runs in a worker of its own
(`packages/core/src/node/worker.ts`). Writers on a shared folder are found by
re-reading it ([data folders](#data-folders)).

The store's overall fingerprint, shown in `spaces.status` and used by tests,
is the Negentropy fingerprint of the sum of every collection's sum, as hex.

_Source: `packages/core/src/storage/storage-provider.ts` (`MAX_BODIES`,
`invalidate`), `packages/core/src/node/worker.ts`. Tests:
`packages/core/tests/reconcile.test.ts` ("a store written by someone else is
read again once told")._

## Storage adapters

A store runs over an adapter with this contract (`StorageAdapter`, all
methods async):

| Method                           | Contract                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(key)`                       | Entry bytes, or null                                                                                                                                        |
| `put(key, bytes)`                | Set an entry                                                                                                                                                |
| `delete(key)`                    | Remove an entry; absent is fine                                                                                                                             |
| `list(prefix?)`                  | Every entry key starting with `prefix`, in no guaranteed order                                                                                              |
| `batch(ops)`                     | Apply `{type:'put',key,value}` / `{type:'delete',key}` ops; should be atomic                                                                                |
| `putVersion(v)`                  | Store a version body by its `id`                                                                                                                            |
| `getVersion(id)`                 | A version body, or null                                                                                                                                     |
| `deleteVersion(id)`              | Remove a version body                                                                                                                                       |
| `close()`                        | Release it                                                                                                                                                  |
| `entries(prefix)`                | _Optional._ Every entry under `prefix` with its bytes, in one read. Without it, `list` then `get` each                                                      |
| `getVersions(ids)`               | _Optional._ Version bodies by id, null where absent, in the order asked, in one read. Without it, `getVersion` each                                         |
| `commit({ store, ops, remove })` | _Optional._ Stores these bodies, applies these entry ops and deletes these bodies, atomically. Without it, `putVersion` each, `batch`, `deleteVersion` each |
| `refresh()`                      | _Optional._ Reads again what another process wrote to the same store; whether anything changed. The space runtime asks every `watchIntervalMs`              |

The optional methods only save round trips: a store gives the same answers
with or without them. With `commit`, one placement of a version is one atomic
write; without, versions go first, then the entries in one batch, then the
deletes, so no entry ever names a version that is not there.

Entry keys are strings; values are bytes. The adapters are IndexedDB (below),
a directory (the data folder's registry), a log file on disk
([below](#stores-on-disk)), the sealing wrapper, and memory.

_Source: `packages/core/src/types.ts` (`StorageAdapter`, `BatchOp`). Tests:
`packages/core/tests/folder-adapter.test.ts`,
`packages/core/tests/helpers/memory-adapter.ts`._

## IndexedDB

`indexedDBStores(prefix)` opens one database per store path, named
`<prefix>:<path with / replaced by :>`. An account signed in in the browser
uses the prefix `minca:<dataPath with / replaced by :>`, for example
`minca:accounts:k3x9q2:stores:spaces:<space id>`; an app connected to an
account home uses `minca-app:<account DID>` (the grant's `did`). Only this origin reads them.

Each database:

- is version **4**. Opening one made at an earlier version deletes its object
  stores and starts empty. Space records are rebuilt by syncing, but the
  registry is lost with it: space keys, unused invite secrets, and versions
  written here but not yet synced. Before v1 that is accepted; after it, a
  schema change must keep the registry.
- has object store `kv`: out-of-line string keys, values `ArrayBuffer`s (the
  entry bytes). `list(prefix)` is a key-range cursor over
  `[prefix, prefix + "￿"]`.
- has object store `versions`: key path `id`, no indexes. Values are the
  version objects.
- writes `batch` as one `readwrite` transaction over `kv`. Bodies are written
  in their own transactions, except through `commit`: one `readwrite`
  transaction over `kv` and `versions`.
- reads `entries(prefix)` with `getAllKeys` and `getAll` over the same key
  range in one `readonly` transaction; `getVersions` is one `readonly`
  transaction.

A data folder's own stores ([below](#data-folders)) use the prefix
`minca-pod:<dataPath with / replaced by :>`: not `minca:`, which is deleted
when the person forgets an account's browser copy.

Accounts kept in a browser live in database `minca-accounts`, object store
`accounts`. A remembered data-folder handle lives in database `minca-folder`,
object store `handles`, key `data-folder`.

A host keeps its subscriptions in its own store, path `host`, under keys
`subscription:<id>` ([spec 06](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).

_Source: `packages/core/src/storage/indexeddb-adapter.ts`,
`packages/core/src/storage/directory-access.ts`,
`packages/core/src/node/stores.ts`, `packages/core/src/session/places.ts`
(`storesFor`), `packages/core/src/node/host.ts`. Tests: none directly (the
adapter needs a browser)._

## Data folders

The folder's layout, file names and the way several writers converge are
protocol ([spec 05 §14](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md)).
How this library keeps and writes one is not.

`folderStores(directory, { basePath, localKey, local })` keeps the
`registry` in the folder, one file per entry, sealed under `localKey`, and
opens every other path in `local`: a space's entries and bodies, what the
node keeps beside them, and the `folder/<space id>` store writer state. The
factory names the folder's segments (`<basePath>/spaces/`, a directory blob
store) as `folder`, and every space runtime opened from it mirrors to them
([mirrors](#mirrors)): it pulls when the space opens and every
`watchIntervalMs` (default 2 s, `0` to turn it off), and pushes 1 s after a
change and on close.

`local` is this device's:

- **In the browser**, IndexedDB under `minca-pod:<dataPath>` (the default).
- **The CLI** keeps it outside the home, which may be the folder a browser
  uses or one a sync service copies: `$MINCA_LOCAL`, else
  `~/Library/Application Support/minca` (macOS), `%LOCALAPPDATA%\minca`
  (Windows) or `$XDG_STATE_HOME/minca` (`~/.local/state/minca`), then
  `<first 16 hex of SHA-256 of the home's path>/<account id>/`, one log file
  per store ([stores on disk](#stores-on-disk)), so a command and the daemon
  share it (`localPath` in `packages/cli/src/home.ts`).
  Its writer keys and their places are there too (`<local>/writers`); a slot
  left in the home from before is not read, and the CLI claims a key of its
  own. `minca agent` still keeps its key and stores together in
  `<home>/agent`.
- **Elsewhere** it must be given: `folderStores` refuses to start without
  one, since a lasting key's places kept in memory would be handed out again
  after a restart.

**The former layout.** A space store kept the old way (`spaces/<id>/kv`,
`versions`) is turned into a segment of a new store writer the first time
the space opens, and its `kv/` and `versions/` deleted
([spec 05 §14.8](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md)).
No other store kept the old way (`writers`, a mirror's state) is read: anyone
who can write the folder could have planted it. A lasting key whose places
were only there starts its lines afresh.

Getting the folder:

- **In the browser** the folder comes from `showDirectoryPicker` with
  `id: "minca-pod"`, `mode: "readwrite"`, `startIn: "documents"`, which needs a
  user gesture. The handle is remembered in IndexedDB (above); on a later visit
  `readwrite` permission is queried, and requested again only from a gesture.
  Browsers without the API (Firefox, Safari, mobile) keep data in IndexedDB
  instead. The File System Access API replaces a file atomically on `close()`.
- **The CLI** (Node and Bun) writes `<name>.<uuid>.tmp` with mode `0600` and
  renames it into place. Directories are created with mode `0700`.

Two folders holding the same account (a copy, a restored backup) share this
device's local stores, which are named by the account's id: a version known
to be in one is not pushed to the other. Open one copy at a time, or let the
other fill in from peers.

A folder is the account: copy it to a USB stick and it is all of it, or put
it in iCloud, Dropbox or Syncthing and several devices converge with no relay,
since the set of versions only grows. Being readable by several origins is the
point, which is why OPFS (origin-private) is not used for it. Each device
adds a folder of segments per space, about one file per 256 KiB of records,
compacted once it has 32 and twice what the last compaction left.

_Source: `packages/core/src/node/stores.ts` (`folderStores`),
`packages/core/src/storage/blob/directory.ts`,
`packages/core/src/storage/directory-access.ts`,
`packages/cli/src/fs-directory.ts`, `packages/cli/src/home.ts` (`unlock`),
`packages/core/src/node/space-runtime.ts` ("Mirrors", "Writers outside this
process"). Tests: `packages/core/tests/folder-adapter.test.ts`,
`packages/cli/tests/path-safety.test.ts`._

## Stores on disk

Nodes the CLI runs (a host, a carrier, an agent, the desktop app's node, and
an account's own stores beside a data folder) keep each store in one file,
`fileStores(root)`: `<root>/<path>.log`, every part of the path named as a
data folder names its files.

- **A log.** Each write is one line of JSON, an array of operations:
  `["put", key, <base64url value>]`, `["del", key]`, `["ver", <version>]`,
  `["unver", id]`. A line is applied whole or not at all: one cut off by a
  crash is skipped, and the next write truncates it first.
- **In memory.** The file is read whole when opened. Once more lines have
  been written since the last snapshot than the store holds entries and
  versions (and at least 1,000), it is rewritten as a snapshot: a temporary
  file renamed into place.
- **Shared.** Every write holds `<file>.lock`, naming the process, taken over
  from a process that is gone or after 30 s, and first reads what other
  processes appended. Every read does too. `refresh()` says whether another
  process wrote since it last asked, so the daemon's watch finds what a
  command did.
- **The registry** is sealed under `localKey` when one is given, as in a
  data folder.
- **The former layout.** A store kept as a directory at the same path, one
  file per entry and per version, is read into the log the first time it is
  opened, then deleted.

_Source: `packages/cli/src/file-stores.ts`. Tests:
`packages/cli/tests/file-stores.test.ts`._

## Blob stores

A blob store keeps bytes by name and is assumed slow, eventually consistent,
and without atomic operations (`BlobStore`):

| Method                     | Contract                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `get(key)`                 | bytes, or null when absent                                            |
| `put(key, bytes)`          | create or replace                                                     |
| `delete(key)`              | remove; absent is fine                                                |
| `list(prefix)`             | every key under `prefix`, any order                                   |
| `changes?(prefix, cursor)` | optional: keys added or removed since `cursor`; no mirror uses it yet |

Drivers:

- **Memory**, for tests.
- **Directory**, over a directory handle or a directory on disk
  (`createDirectoryBlobStore`): each `/`-separated part of a key a
  directory, the last a file, every part named as a data folder names its
  files; a directory is removed with the last key in it. What a data folder
  keeps its spaces in.
- **S3-compatible** (R2, B2, MinIO, Wasabi, AWS): path-style URLs
  `<endpoint>/<bucket>/<prefix/><key>`, each `/`-separated part
  `encodeURIComponent`-ed; SigV4-signed (`aws4fetch`), region default
  `auto`; `list` is `ListObjectsV2` (`list-type=2`) following continuation
  tokens; `get` 404 is null; `delete` 404 is success; 429 and 5xx are retried
  up to 5 attempts, waiting `Retry-After` seconds if given, else
  `min(200·2^attempt, 5000) ms` times a random factor in [0.75, 1.25).

_Source: `packages/core/src/storage/blob-store.ts`,
`packages/core/src/storage/blob/memory.ts`,
`packages/core/src/storage/blob/directory.ts`,
`packages/core/src/storage/blob/s3.ts`. Tests:
`packages/core/tests/mirror.test.ts`._

## Mirrors

A mirror's segments, where a store writer may write and how it pulls and compacts
are protocol ([spec 05 §16](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md)).
Today data folders, carriers and hosts mirror.

A store writer keeps its state in the store `mirrors/<space id>/<n>`, where `n` is
the mirror's index:

| Key                            | Value                                          |
| ------------------------------ | ---------------------------------------------- |
| `mirror:writer`                | the writer id                                  |
| `mirror:counter`               | the segment counter, decimal                   |
| `mirror:read:<segment key>`    | `1`, for each segment read or written          |
| `mirror:known:<version id>`    | `1`, for each version known to be in the store |
| `mirror:uploaded:<version id>` | `1`, for each version this writer uploaded     |

"Known" is everything this store writer uploaded **or read**, so nobody re-uploads
everyone else's versions.

A store writer pushes 5 s after the first change (1 s for a data folder) and
on close, packing what is not yet known into segments of about 256 KiB (a
segment is closed once it reaches that size). It reads the `mirror:known:`
entries once, when it starts. Once it has 32 or more segments of its own,
and twice as many as its last compaction left, it compacts them: the store's
copy of what it holds, and what it marked uploaded, read again then; nothing
else in them.

_Source: `packages/core/src/storage/mirror.ts`,
`packages/core/src/node/space-runtime.ts` ("Mirrors"),
`packages/core/src/node/host.ts`. Tests: `packages/core/tests/mirror.test.ts`._

### Planned: mirrors in your own storage

> **Planned.** Mirrors on any node, in storage the person already has. What
> a mirror holds, and absorbing a store writer that went quiet, are protocol and
> planned in [spec 05 §16.5](https://github.com/leifriksheim/minca/blob/main/spec/05-sync-and-storage.md).

- **Any node, several mirrors.** A node will take a list of blob stores
  (`NodeConfig.mirrors`), one per space each, since a person may have their
  own Dropbox and a host's bucket at once. It pulls when a space opens and on
  each change notice, and flushes after local writes and on close. Two devices
  never online together then meet through the store.
- **Change feeds.** Where the service has one, pull uses `BlobStore.changes`
  instead of listing: Dropbox `list_folder/continue` with long polling, Drive
  `changes.list`. S3 and directories list.
- **More drivers**, each passing one contract suite (round-trips, absent is
  null, a second delete is fine, `list` over several pages, keys with slashes
  and unicode, a 1 MB blob), with shared backoff on 429 and 5xx that honours
  `Retry-After`, never retries a delete that returned 404, and never logs a
  token or signed URL:
  - _Google Drive_: everything in one app-created folder, `drive.file` scope
    only (the app sees only its own files). Drive addresses files by id, not
    name, so the driver keeps a name → file id map from one `files.list`,
    updated on every `put` and invalidated on 404. Drive allows duplicate
    names, so a `put` updates an existing file id rather than creating
    another. Tokens come from a callback (`getAccessToken`); service accounts
    do not work (they have no storage of their own).
  - _Dropbox_ and _OneDrive_, in their app folders, the narrowest grant each
    offers. Dropbox first.
  - Not iCloud: it has no usable web API; iCloud users keep a data folder
    instead.
- **Budget.** A store like Drive allows about 1,000 requests per 100 seconds.
  The segment, never the single version, is the unit fetched, and syncing
  1,000 records must fit that budget.
