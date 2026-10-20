/**
 * Stores on this computer's disk, one file each: `<root>/spaces/<id>.log`,
 * `<root>/registry.log`. A file per entry and per version, as a data folder
 * once kept them, is several files for every record, which a disk pays for
 * in blocks and a backup in time.
 *
 * Each file is a log: one line of JSON per write, appended, so a write lands
 * whole or, cut off, not at all. It is read whole when opened and kept in
 * memory, and rewritten as a snapshot once it holds much more than that.
 *
 * Several processes may share one: a command run beside the daemon. Every
 * write takes a lock file naming the process, reads what the others appended
 * first, then appends; `refresh` reads what they appended since, so the
 * daemon's watch finds a command's writes.
 *
 * A store kept in the former layout at the same path (`<root>/spaces/<id>/kv`,
 * `versions`) is read into the log when first opened, then removed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createEncryptedAdapter,
  decodeFolderName,
  encodeFolderName,
  type BatchOp,
  type StorageAdapter,
  type StoreFactory,
  type Version,
} from '@minca/core';
import { errorCode, isRecord } from './json.js';

/** One write, as a line of the log */
type Op =
  | readonly ['put', string, string]
  | readonly ['del', string]
  | readonly ['ver', Version]
  | readonly ['unver', string];

/** A lock naming no process (one cut off while written) is left over once this old */
const STALE_LOCK_MS = 30_000;
/** Ops per line of a snapshot */
const SNAPSHOT_LINE = 500;

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const decode = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

const isVersion = (value: unknown): value is Version => isRecord(value) && typeof value.id === 'string';

function isOp(value: unknown): value is Op {
  if (!Array.isArray(value)) return false;
  const parts: readonly unknown[] = value;
  const [kind, a, b] = parts;
  if (kind === 'put') return typeof a === 'string' && typeof b === 'string';
  if (kind === 'del' || kind === 'unver') return typeof a === 'string';
  return kind === 'ver' && isVersion(a);
}

/** Whether a process is still running */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as someone else.
    return errorCode(error) === 'EPERM';
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `work` holding `<file>.lock`, taking it from a process that is gone */
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  for (;;) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const [holder, info] = await Promise.all([
        fs.readFile(lock, 'utf8').catch(() => ''),
        fs.stat(lock).catch(() => null),
      ]);
      const pid = Number(holder);
      // A live holder keeps it however long it takes; age only decides for a lock naming nobody.
      const named = Number.isSafeInteger(pid) && pid > 0;
      const gone = named ? !alive(pid) : !!info && Date.now() - info.mtimeMs > STALE_LOCK_MS;
      if (gone) await fs.rm(lock, { force: true });
      else await wait(2 + Math.random() * 8);
    }
  }
  try {
    return await work();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/** A store path's parts as names on disk; a part that would reach outside `root` is refused */
function namesOf(storePath: string): string[] {
  const parts = storePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    throw new Error(`Not a store path: ${JSON.stringify(storePath)}`);
  return parts.map(encodeFolderName);
}

/** Reads a store in the former layout: one file per entry in `kv/`, per version in `versions/` */
async function readFormer(dir: string): Promise<Op[] | null> {
  const ops: Op[] = [];
  const names = async (sub: string) => (await fs.readdir(path.join(dir, sub)).catch(() => null)) ?? null;
  const kv = await names('kv');
  const versions = await names('versions');
  if (!kv && !versions) return null;
  for (const name of kv ?? []) {
    if (name.endsWith('.tmp')) continue;
    const bytes = await fs.readFile(path.join(dir, 'kv', name)).catch(() => null);
    if (bytes) ops.push(['put', decodeFolderName(name), encode(bytes)]);
  }
  for (const name of versions ?? []) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, 'versions', name), 'utf8'));
      if (isVersion(parsed)) ops.push(['ver', parsed]);
    } catch {
      // Half-written: it never counted.
    }
  }
  return ops;
}

/** The lines a snapshot of these ops takes */
function snapshotLines(ops: ReadonlyArray<Op>): string[] {
  const lines: string[] = [];
  for (let at = 0; at < ops.length; at += SNAPSHOT_LINE)
    lines.push(`${JSON.stringify(ops.slice(at, at + SNAPSHOT_LINE))}\n`);
  return lines;
}

/** Replaces a file whole */
async function writeWhole(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Opens the log store at `file`, reading `former` into it first if there is one */
export async function openFileStore(file: string, former?: string): Promise<StorageAdapter> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (former) {
    await locked(file, async () => {
      if (await fs.stat(file).catch(() => null)) return;
      const ops = await readFormer(former);
      if (!ops) return;
      await writeWhole(file, snapshotLines(ops).join(''));
      await fs.rm(former, { recursive: true, force: true });
    });
  }

  let entries = new Map<string, Uint8Array>();
  let versions = new Map<string, Version>();
  /** How far into the file this process has read */
  let offset = 0;
  /** Which file that was: a snapshot replaces it with another */
  let inode = 0;
  /** Lines read or written since the file was last a snapshot, to tell when the next is due */
  let lines = 0;
  /** Whether another process's writes were read since `refresh` last said so */
  let foreign = false;

  const apply = (op: Op) => {
    if (op[0] === 'put') entries.set(op[1], decode(op[2]));
    else if (op[0] === 'del') entries.delete(op[1]);
    else if (op[0] === 'ver') versions.set(op[1].id, op[1]);
    else versions.delete(op[1]);
  };

  /** Applies the complete lines in `text`; how many bytes they took */
  const applyLines = (text: Buffer): number => {
    const end = text.lastIndexOf(0x0a) + 1;
    for (const line of text.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      lines += 1;
      try {
        const ops: unknown = JSON.parse(line);
        if (Array.isArray(ops)) for (const op of ops) if (isOp(op)) apply(op);
      } catch {
        // A line cut off and then written over is skipped, never half applied.
      }
    }
    return end;
  };

  /** Reads what was appended since, or all of it again if the file was replaced */
  async function catchUp(): Promise<void> {
    const info = await fs.stat(file).catch(() => null);
    if (!info) {
      if (inode === 0) return;
      entries = new Map();
      versions = new Map();
      offset = inode = lines = 0;
      foreign = true;
      return;
    }
    if (info.ino !== inode || info.size < offset) {
      entries = new Map();
      versions = new Map();
      lines = 0;
      inode = info.ino;
      offset = applyLines(await fs.readFile(file));
      foreign = true;
      return;
    }
    if (info.size === offset) return;
    const handle = await fs.open(file, 'r');
    try {
      const fresh = Buffer.alloc(info.size - offset);
      await handle.read(fresh, 0, fresh.length, offset);
      const used = applyLines(fresh);
      if (used > 0) foreign = true;
      offset += used;
    } finally {
      await handle.close();
    }
  }

  // Writes in this process go one at a time; across processes, under the lock.
  let queue: Promise<unknown> = Promise.resolve();
  function write(ops: ReadonlyArray<Op>): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    const next = queue.then(() =>
      locked(file, async () => {
        await catchUp();
        // A line a crashed writer cut off would swallow this one.
        const info = await fs.stat(file).catch(() => null);
        if (info && info.size > offset) await fs.truncate(file, offset);
        const line = `${JSON.stringify(ops)}\n`;
        await fs.appendFile(file, line, { mode: 0o600 });
        if (inode === 0) inode = (await fs.stat(file)).ino;
        offset += Buffer.byteLength(line);
        lines += 1;
        for (const op of ops) apply(op);
        // Once there have been more writes than there are things held, each
        // thing has been rewritten about once per write: the cost stays even.
        if (lines > Math.max(1000, entries.size + versions.size)) await snapshot();
      }),
    );
    queue = next.catch(() => {});
    return next;
  }

  /** Rewrites the file as what it holds now */
  async function snapshot(): Promise<void> {
    const ops: Op[] = [
      ...[...entries].map(([key, value]): Op => ['put', key, encode(value)]),
      ...[...versions.values()].map((version): Op => ['ver', version]),
    ];
    const text = snapshotLines(ops);
    await writeWhole(file, text.join(''));
    const info = await fs.stat(file);
    inode = info.ino;
    offset = info.size;
    lines = 0;
  }

  await catchUp();
  foreign = false;

  const opsOf = (batch: ReadonlyArray<BatchOp>): Op[] =>
    batch.map((op): Op => (op.type === 'put' ? ['put', op.key, encode(op.value)] : ['del', op.key]));

  return Object.freeze({
    async get(key: string) {
      await catchUp();
      return entries.get(key) ?? null;
    },
    put: (key: string, value: Uint8Array) => write([['put', key, encode(value)]]),
    delete: (key: string) => write([['del', key]]),
    async list(prefix = '') {
      await catchUp();
      return [...entries.keys()].filter((key) => key.startsWith(prefix));
    },
    async entries(prefix: string) {
      await catchUp();
      return [...entries].filter(([key]) => key.startsWith(prefix));
    },
    putVersion: (version: Version) => write([['ver', version]]),
    async getVersion(id: string) {
      await catchUp();
      return versions.get(id) ?? null;
    },
    async getVersions(ids: ReadonlyArray<string>) {
      await catchUp();
      return ids.map((id) => versions.get(id) ?? null);
    },
    deleteVersion: (id: string) => write([['unver', id]]),
    batch: (batch: ReadonlyArray<BatchOp>) => write(opsOf(batch)),
    commit: ({ store, ops, remove }) =>
      write([
        ...store.map((version): Op => ['ver', version]),
        ...opsOf(ops),
        ...remove.map((id): Op => ['unver', id]),
      ]),
    async refresh() {
      await catchUp();
      const changed = foreign;
      foreign = false;
      return changed;
    },
    async close() {
      await queue;
    },
  } satisfies StorageAdapter);
}

/**
 * Stores under `root`, one log file each.
 * @param options.localKey Seals the registry, as in a data folder (spec 05 §15)
 */
export function fileStores(
  root: string,
  options: { readonly localKey?: CryptoKey | null } = {},
): StoreFactory {
  return async (storePath, storeOptions) => {
    const names = namesOf(storePath);
    const file = `${path.join(root, ...names)}.log`;
    const adapter = await openFileStore(file, path.join(root, ...names));
    return storeOptions?.seal && options.localKey
      ? createEncryptedAdapter(adapter, options.localKey)
      : adapter;
  };
}
