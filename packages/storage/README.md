# @minca/storage

Where a [Minca](https://minca.dev) node keeps its data. Each kind of store is
its own entry point, so an app bundles only the one it uses.

```ts
import { createNode } from '@minca/core';
import { indexedDBStores } from '@minca/storage/indexeddb';

const node = await createNode({ signer, stores: indexedDBStores('my-app') });
```

| Entry point                | Keeps a node's data                                    |
| -------------------------- | ------------------------------------------------------ |
| `@minca/storage/indexeddb` | in this browser's IndexedDB                            |
| `@minca/storage/folder`    | in a directory, or a data folder several apps share    |
| `@minca/storage/sqlite`    | in one SQLite database, through Node's or Bun's driver |
| `@minca/storage/s3`        | a mirror's files, in an S3-compatible bucket           |
| `@minca/storage/memory`    | in memory, for tests                                   |

To keep data somewhere else, write a `StorageAdapter` from `@minca/core`.
See [sync and storage](https://minca.dev/node/storage/).
