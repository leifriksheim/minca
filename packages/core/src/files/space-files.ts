/**
 * A space's files on this node (spec 05 §16.6): kept as entries in the
 * space's own store, fetched from peers or mirrors chunk by chunk and checked
 * as they come, served to peers, and dropped with the bodies that name them.
 *
 * ```
 * f/<id>/list     the chunk list
 * f/<id>/<n>      chunk n
 * f/<id>/own      added here and not yet named: the time it was added
 * f/<id>/used     when it was last fetched or read, and its size; kept when dropped
 * ```
 */
import type { StorageAdapter, Version } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { SyncMessageBody } from '../sync/sync-messages.js';
import {
  CHUNK,
  chunkCount,
  chunkFits,
  chunkLength,
  chunkListOf,
  fileIdOf,
  filesOf,
  listFits,
  MAX_FILE_SIZE,
  type FileName,
} from './file-id.js';
import { openFile, sealFile, type FileKey } from './seal.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord, unref } from '../utils/guards.js';

/** What `addFile` gives back: what names the file on a version, and what opens it, for the body */
export type SealedFile = FileName & FileKey;

/** A mirror a space's files are kept in, as its store writer */
export interface FileMirror {
  readonly store: BlobStore;
  readonly writer: string;
}

export interface SpaceFilesConfig {
  readonly space: string;
  readonly adapter: StorageAdapter;
  readonly storage: StorageProvider;
  /** Sends a sync message to a peer */
  readonly send: (peer: string, message: SyncMessageBody) => void;
  /** The peers connected now */
  readonly peers: () => ReadonlyArray<string>;
  /** Mirrors the space is kept in */
  readonly mirrors?: () => ReadonlyArray<FileMirror>;
  /** Whether a version stands: a version that doesn't, though kept whole, keeps no files here */
  readonly stands?: (version: Version) => Promise<boolean>;
  /** Whether a version is this account's own: files it names are never dropped */
  readonly mine?: (version: Version) => Promise<boolean>;
  /** Limits on the files others wrote, for a device; absent, every file named is fetched and kept */
  readonly limits?: FileLimits;
}

export interface FileLimits {
  /** The largest file fetched before anyone reads it; a larger one is fetched when read */
  readonly ahead: number;
  /** The bytes of files others wrote a space keeps; past it, those used longest ago are dropped */
  readonly keep: number;
}

/** A device's limits: photos and documents come ahead, video when played */
export const DEVICE_LIMITS: FileLimits = Object.freeze({ ahead: 5 * 1024 * 1024, keep: 256 * 1024 * 1024 });

/** Chunks asked of a peer in one `want-file` */
const MAX_CHUNKS_PER_WANT = 64;
/** Chunks the largest file has: no index is ever this or more */
const MAX_CHUNKS = MAX_FILE_SIZE / CHUNK;
/** A request that hears nothing for this long is given up, and what it lacks asked elsewhere */
const IDLE_MS = 5_000;
/** A file nobody had is not asked of everyone again before this; a peer that connects since is asked at once */
const RETRY_MS = 10 * 60_000;
/** Chunks a peer sends in answer to one `want-file`; the rest it leaves for the next ask */
const CHUNKS_PER_REPLY = 4;
/** How often a file a read waits for is asked of everyone again, while nothing else asks */
const WAIT_MS = 15_000;
/** Bytes in one `file` message, before base64 */
const BYTES_PER_MESSAGE = 24_000;
/** A request with no answer by now is given up, and the chunks asked elsewhere */
const REQUEST_MS = 30_000;
/** A file added here and never named is dropped after this */
const UNNAMED_MS = 24 * 60 * 60 * 1000;

const listKey = (id: string) => `f/${id}/list`;
const chunkKey = (id: string, index: number) => `f/${id}/${index}`;
const ownKey = (id: string) => `f/${id}/own`;
const usedKey = (id: string) => `f/${id}/used`;

type Part = number | 'list';

interface Request {
  readonly peer: string;
  readonly file: FileName;
  readonly asked: ReadonlySet<Part>;
  readonly done: Set<Part>;
  readonly parts: Map<Part, Uint8Array[]>;
  readonly received: Map<Part, number>;
  readonly settle: () => void;
  /** Heard from: the wait for the next frame starts again */
  readonly touch: () => void;
  list: Uint8Array | null;
}

export type SpaceFiles = ReturnType<typeof createSpaceFiles>;

export function createSpaceFiles(config: SpaceFilesConfig) {
  const { adapter, storage } = config;

  // ─── Which files this node keeps ───────────────────────────────────

  let named: Promise<Map<string, FileName[]>> | null = null;
  /**
   * Every file a version this store keeps whole names, and that stands, by
   * id. Versions may name one id with different sizes; the id binds the size,
   * so only one is ever the file, and the others are never satisfied.
   */
  /** Versions already looked at, and those of them that name files: the rest are never read again */
  const scanned = new Set<string>();
  const namers = new Set<string>();
  /** The files this account's own versions name, as of the last `namedFiles` */
  let mine = new Set<string>();
  const namedFiles = (): Promise<Map<string, FileName[]>> =>
    (named ??= (async () => {
      const files = new Map<string, FileName[]>();
      const own = new Set<string>();
      const kept = await storage.versionIds();
      for (const id of kept) {
        // Only versions not seen before, and those that name files (which may since be stubs).
        if (scanned.has(id) && !namers.has(id)) continue;
        scanned.add(id);
        const version = await storage.getVersion(id);
        if (!version || filesOf(version).length === 0) {
          namers.delete(id);
          continue;
        }
        namers.add(id);
        if (!('body' in version)) continue;
        const taken = filesOf(version);
        if (config.stands && !(await config.stands(version))) continue;
        if (await config.mine?.(version)) for (const file of taken) own.add(file.hash);
        for (const file of taken) {
          const sizes = files.get(file.hash) ?? [];
          if (!sizes.some((known) => known.size === file.size)) sizes.push(file);
          files.set(file.hash, sizes);
        }
      }
      // Versions this store dropped are forgotten here too.
      if (scanned.size > kept.length) {
        const still = new Set(kept);
        for (const id of scanned) {
          if (still.has(id)) continue;
          scanned.delete(id);
          namers.delete(id);
        }
      }
      mine = own;
      return files;
    })());
  const isNamed = async (file: FileName) =>
    (await namedFiles()).get(file.hash)?.some((known) => known.size === file.size) ?? false;
  /** The one of the sizes named for an id that its held chunk list fits: the file itself */
  async function heldFile(hash: string): Promise<FileName | null> {
    const list = await adapter.get(listKey(hash));
    if (!list) return null;
    for (const file of (await namedFiles()).get(hash) ?? []) if (await listFits(file, list)) return file;
    return null;
  }
  const isWhole = async (file: FileName) =>
    (await heldFile(file.hash))?.size === file.size &&
    (await heldChunks(file)).size === chunkCount(file.size);

  // ─── Local chunks ──────────────────────────────────────────────────

  async function heldList(file: FileName): Promise<Uint8Array | null> {
    return adapter.get(listKey(file.hash));
  }

  /** The chunks of a file held here */
  async function heldChunks(file: FileName): Promise<Set<number>> {
    const held = new Set<number>();
    for (const key of await adapter.list(`f/${file.hash}/`)) {
      const index = Number(key.slice(`f/${file.hash}/`.length));
      if (Number.isInteger(index)) held.add(index);
    }
    return held;
  }

  async function keepChunk(file: FileName, index: number, bytes: Uint8Array): Promise<void> {
    await adapter.put(chunkKey(file.hash, index), bytes);
    // A file of one chunk needs no list to be checked; it is kept for serving all the same.
    if (chunkCount(file.size) === 1) await adapter.put(listKey(file.hash), await chunkListOf(bytes));
  }

  /** Seals a file, keeps it, and gives back what names and opens it */
  async function add(plain: Uint8Array): Promise<SealedFile> {
    if (plain.length + 17 * Math.ceil((plain.length + 1) / (CHUNK - 17)) > MAX_FILE_SIZE)
      throw new Error('A file is at most 2 GiB');
    const { bytes, key } = await sealFile(plain);
    const list = await chunkListOf(bytes);
    const hash = await fileIdOf(bytes.length, list);
    const ops = [
      { type: 'put' as const, key: listKey(hash), value: list },
      { type: 'put' as const, key: ownKey(hash), value: utf8Encode(String(Date.now())) },
    ];
    for (let index = 0; index * CHUNK < bytes.length; index++)
      ops.push({
        type: 'put' as const,
        key: chunkKey(hash, index),
        value: bytes.slice(index * CHUNK, (index + 1) * CHUNK),
      });
    await adapter.batch(ops);
    return { hash, size: bytes.length, ...key };
  }

  // ─── Fetching ──────────────────────────────────────────────────────

  const requests = new Map<number, Request>();
  let lastRequest = 0;
  /** Peers that answered nothing, and when: asked again only after `RETRY_MS` */
  const silent = new Map<string, number>();
  const askable = () => config.peers().filter((peer) => Date.now() - (silent.get(peer) ?? 0) >= RETRY_MS);

  /** Asks one peer for parts of a file; resolves with what arrived and checked, once it says it is done */
  function ask(peer: string, file: FileName, parts: ReadonlyArray<Part>, list: Uint8Array | null) {
    return new Promise<Set<Part>>((resolve) => {
      const id = ++lastRequest;
      const done = new Set<Part>();
      let heard = false;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(idle);
        requests.delete(id);
        // Nothing at all back, not even `file-done`: a peer that predates files, or won't say. Skipped a while.
        if (!heard) silent.set(peer, Date.now());
        resolve(done);
      };
      // Given up when it falls silent, or at the latest after REQUEST_MS: a peer that trickles is left for another.
      const timer = setTimeout(finish, REQUEST_MS);
      let idle = setTimeout(finish, IDLE_MS);
      const touch = () => {
        heard = true;
        clearTimeout(idle);
        idle = setTimeout(finish, IDLE_MS);
      };
      requests.set(id, {
        peer,
        file,
        asked: new Set(parts),
        done,
        parts: new Map(),
        received: new Map(),
        settle: finish,
        touch,
        list,
      });
      const numbers = parts.filter((part): part is number => part !== 'list');
      config.send(
        peer,
        numbers.length
          ? { type: 'want-file', id, hash: file.hash, chunks: [numbers[0]!, numbers.at(-1)!] }
          : { type: 'want-file', id, hash: file.hash, list: true },
      );
    });
  }

  /** Runs of consecutive indices, at most `MAX_CHUNKS_PER_WANT` long: what one `want-file` can ask */
  function runs(indices: ReadonlyArray<number>): number[][] {
    const out: number[][] = [];
    for (const index of indices) {
      const run = out.at(-1);
      if (run && run.at(-1) === index - 1 && run.length < MAX_CHUNKS_PER_WANT) run.push(index);
      else out.push([index]);
    }
    return out;
  }

  /** Reads a file from a mirror, checking it as from a peer */
  async function fromMirrors(file: FileName): Promise<boolean> {
    for (const mirror of config.mirrors?.() ?? []) {
      try {
        const copies = (await mirror.store.list(`files/${config.space}/`)).filter((key) =>
          key.endsWith(`/${file.hash}`),
        );
        // Every store writer's copy in turn: one that fails its checks hides none of the others.
        for (const at of copies) if (await fromCopy(mirror, at, file)) return true;
      } catch {
        // Out of reach; the next one, or none.
      }
    }
    return false;
  }

  /** One store writer's copy of a file in a mirror, checked as from a peer, and kept if it passes */
  async function fromCopy(mirror: FileMirror, at: string, file: FileName): Promise<boolean> {
    const list = await mirror.store.get(`${at}.list`);
    if (!list || !(await listFits(file, list))) return false;
    const bytes = await mirror.store.get(at);
    if (!bytes || bytes.length !== file.size) return false;
    const chunks: Array<[number, Uint8Array]> = [];
    for (let index = 0; index < chunkCount(file.size); index++) {
      const chunk = bytes.slice(index * CHUNK, (index + 1) * CHUNK);
      if (!(await chunkFits(file, list, index, chunk))) return false;
      chunks.push([index, chunk]);
    }
    await adapter.put(listKey(file.hash), list);
    for (const [index, chunk] of chunks) await adapter.put(chunkKey(file.hash, index), chunk);
    return true;
  }

  const fetching = new Map<string, Promise<void>>();
  /** Fetches whatever of a file is not held here: from peers, then mirrors. Throws if none has it all. */
  function fetchFile(
    file: FileName,
    peers: ReadonlyArray<string> = askable(),
    mirrors = true,
  ): Promise<void> {
    const at = `${file.hash}:${file.size}`;
    const running = fetching.get(at);
    if (running) return running;
    const work = (async () => {
      const n = chunkCount(file.size);
      let list = n === 1 ? null : await heldList(file);
      const missing = async () => {
        const held = await heldChunks(file);
        return Array.from({ length: n }, (_, i) => i).filter((i) => !held.has(i));
      };
      for (const peer of peers) {
        if (n > 1 && !list) {
          await ask(peer, file, ['list'], null);
          list = await heldList(file);
          if (!list) continue;
        }
        // Ask this peer again while it brings something; the next one once it brings nothing.
        for (let left = await missing(); left.length > 0; left = await missing()) {
          let brought = 0;
          for (const run of runs(left)) brought += (await ask(peer, file, run, list)).size;
          if (brought === 0) break;
        }
        if ((await missing()).length === 0) return;
      }
      if ((await missing()).length === 0) return;
      if (mirrors && (await fromMirrors(file))) return;
      throw new Error('No peer or mirror holds that file now');
    })()
      // Here whole, fetched or read: used now, at the size its list fits, whatever size was asked.
      .then(async () => {
        const held = await heldFile(file.hash);
        if (held) await adapter.put(usedKey(file.hash), utf8Encode(`${Date.now()} ${held.size}`));
      })
      .finally(() => fetching.delete(at));
    fetching.set(at, work);
    return work;
  }

  /** Files being read now, and by how many reads: none is dropped meanwhile */
  const reading = new Map<string, number>();
  /** A file's bytes as stored: held here, or fetched */
  async function read(file: FileName): Promise<Uint8Array> {
    const held = (await heldChunks(file)).size === chunkCount(file.size);
    // A peer is asked only for a file a version kept whole here names (spec 05 §16.6).
    if (!held && !(await isNamed(file))) throw new Error('No record here names that file');
    reading.set(file.hash, (reading.get(file.hash) ?? 0) + 1);
    try {
      await fetchFile(file);
      const pieces: Uint8Array[] = [];
      for (let index = 0; index < chunkCount(file.size); index++) {
        const chunk = await adapter.get(chunkKey(file.hash, index));
        if (!chunk) throw new Error('A chunk of that file went missing');
        pieces.push(chunk);
      }
      return concatBytes(...pieces);
    } finally {
      const left = (reading.get(file.hash) ?? 1) - 1;
      if (left > 0) reading.set(file.hash, left);
      else reading.delete(file.hash);
    }
  }

  // ─── Messages ──────────────────────────────────────────────────────

  async function onFile(peer: string, message: Record<string, unknown>): Promise<void> {
    const request = typeof message.id === 'number' ? requests.get(message.id) : undefined;
    if (!request || request.peer !== peer || message.hash !== request.file.hash) return;
    const part: Part | null =
      message.chunk === 'list' ? 'list' : typeof message.chunk === 'number' ? message.chunk : null;
    if (part === null || !request.asked.has(part) || request.done.has(part)) return;
    if (typeof message.at !== 'number' || typeof message.bytes !== 'string') return;
    const length =
      part === 'list' ? 32 * chunkCount(request.file.size) : chunkLength(request.file.size, part);
    const bytes = base64UrlDecode(message.bytes);
    const received = request.received.get(part) ?? 0;
    // In order, within its length: anything else is dropped, and the part asked again elsewhere.
    if (message.at !== received || received + bytes.length > length || bytes.length > BYTES_PER_MESSAGE)
      return;
    request.touch();
    const pieces = request.parts.get(part) ?? [];
    pieces.push(bytes);
    request.parts.set(part, pieces);
    request.received.set(part, received + bytes.length);
    if (received + bytes.length < length) return;
    const whole = concatBytes(...pieces);
    request.parts.delete(part);
    if (part === 'list') {
      if (!(await listFits(request.file, whole))) return;
      await adapter.put(listKey(request.file.hash), whole);
      request.list = whole;
    } else {
      if (!(await chunkFits(request.file, request.list, part, whole))) return;
      await keepChunk(request.file, part, whole);
    }
    request.done.add(part);
  }

  async function serve(peer: string, message: Record<string, unknown>): Promise<void> {
    if (typeof message.id !== 'number' || typeof message.hash !== 'string') return;
    const { id, hash } = message;
    // The size its held list fits, whatever other sizes other versions name for the id.
    const file = await heldFile(hash);
    const missing: Part[] = [];
    const sendPart = async (chunk: Part, bytes: Uint8Array) => {
      for (let at = 0; at < bytes.length; at += BYTES_PER_MESSAGE) {
        // A turn between frames, so the node's other messages go out between them (spec 05 §16.6).
        if (at > 0) await new Promise((resolve) => setTimeout(resolve, 0));
        config.send(peer, {
          type: 'file',
          id,
          hash,
          chunk,
          at,
          bytes: base64UrlEncode(bytes.subarray(at, at + BYTES_PER_MESSAGE)),
        });
      }
    };
    if (message.list === true) {
      const list = file ? await heldList(file) : null;
      if (list) await sendPart('list', list);
      else missing.push('list');
    } else if (Array.isArray(message.chunks)) {
      const range: readonly unknown[] = message.chunks;
      const [from, to] = range;
      // Indices a file can have, at most 64 of them: anything else is dropped unanswered (spec 05 §16.6).
      if (
        typeof from !== 'number' ||
        typeof to !== 'number' ||
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to < from ||
        to >= MAX_CHUNKS ||
        to - from >= MAX_CHUNKS_PER_WANT
      )
        return;
      {
        const last = file ? Math.min(to, chunkCount(file.size) - 1) : to;
        let sent = 0;
        for (let index = from; index <= to; index++) {
          if (index > last) {
            missing.push(index);
            continue;
          }
          const chunk = file && sent < CHUNKS_PER_REPLY ? await adapter.get(chunkKey(hash, index)) : null;
          if (chunk) {
            await sendPart(index, chunk);
            sent++;
          } else missing.push(index);
        }
      }
    }
    config.send(peer, { type: 'file-done', id, hash, missing });
  }

  function onDone(peer: string, message: Record<string, unknown>): void {
    const request = typeof message.id === 'number' ? requests.get(message.id) : undefined;
    if (!request || request.peer !== peer || message.hash !== request.file.hash) return;
    request.touch();
    request.settle();
  }

  /** A files message from a peer, as the sync engine passes it on */
  async function onMessage(peer: string, message: unknown): Promise<void> {
    if (!isRecord(message)) return;
    if (message.type === 'want-file') await serve(peer, message);
    else if (message.type === 'file') await onFile(peer, message);
    else if (message.type === 'file-done') onDone(peer, message);
  }

  // ─── Keeping, dropping, mirroring ──────────────────────────────────

  /** Drops what no version kept whole names, and pushes what is to the mirrors */
  async function tidy(): Promise<void> {
    const wanted = await namedFiles();
    const ids = new Set<string>();
    for (const key of await adapter.list('f/')) ids.add(key.split('/')[1]!);
    for (const id of ids) {
      if (wanted.has(id)) {
        if (await adapter.get(ownKey(id))) await adapter.delete(ownKey(id));
        continue;
      }
      const added = await adapter.get(ownKey(id));
      if (added && Date.now() - Number(utf8Decode(added)) < UNNAMED_MS) continue;
      const keys = await adapter.list(`f/${id}/`);
      await adapter.batch(keys.map((key) => ({ type: 'delete' as const, key })));
    }
    for (const mirror of config.mirrors?.() ?? []) {
      const mine = `files/${config.space}/${mirror.writer}/`;
      const there = new Set(await mirror.store.list(mine));
      for (const hash of wanted.keys()) {
        if (there.has(`${mine}${hash}`)) continue;
        // Only the file itself: the size its list fits, held whole.
        const file = await heldFile(hash);
        const list = file ? await heldList(file) : null;
        if (!file || !list || !(await isWhole(file))) continue;
        await mirror.store.put(`${mine}${hash}.list`, list);
        await mirror.store.put(`${mine}${hash}`, await read(file));
      }
      for (const key of there) {
        const id = key.slice(mine.length).replace(/\.list$/, '');
        if (!wanted.has(id)) await mirror.store.delete(key);
      }
    }
    if (config.limits) await dropLeastUsed(config.limits.keep);
  }

  /**
   * Past `keep` bytes, drops the files others wrote that were used longest ago.
   * Their `used` mark stays, so they aren't fetched unread again; a read
   * fetches them.
   */
  async function dropLeastUsed(keep: number): Promise<void> {
    await namedFiles();
    const parts = new Map<string, string[]>();
    for (const key of await adapter.list('f/')) {
      const [, id = '', part = ''] = key.split('/');
      parts.set(id, [...(parts.get(id) ?? []), part]);
    }
    const held: { id: string; at: number; size: number }[] = [];
    let total = 0;
    for (const [id, has] of parts) {
      // Anything held of one fetched or read here, list or not; added here, it is this node's own.
      if (mine.has(id) || has.includes('own') || !has.includes('used') || has.length === 1) continue;
      const [at = 0, size = 0] = utf8Decode((await adapter.get(usedKey(id))) ?? new Uint8Array())
        .split(' ')
        .map(Number);
      held.push({ id, at, size });
      total += size;
    }
    held.sort((a, b) => a.at - b.at);
    for (const file of held) {
      if (total <= keep) return;
      // One being fetched or read now is left for the next pass.
      if (reading.has(file.id) || [...fetching.keys()].some((at) => at.startsWith(`${file.id}:`))) continue;
      const keys = (await adapter.list(`f/${file.id}/`)).filter((key) => key !== usedKey(file.id));
      await adapter.batch(keys.map((key) => ({ type: 'delete' as const, key })));
      total -= file.size;
    }
  }

  /** Files a sweep found nobody had, and when it last asked everyone */
  const unfound = new Map<string, number>();
  /** Peers connected since the last sweep: asked at once for what nobody else had */
  const joined = new Set<string>();
  /** Reads waiting for a file nobody had, one wait per file id */
  const waiting = new Map<string, { done: Promise<Error | null>; settle: (error: Error | null) => void }>();
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  /** Fetches a file at any size named for it, its own first if its list is here; whether it was here, came, or neither */
  async function fetchAny(
    hash: string,
    sizes: ReadonlyArray<FileName>,
    peers: ReadonlyArray<string>,
    mirrors: boolean,
  ): Promise<'here' | 'fetched' | null> {
    const held = await heldFile(hash);
    if (held && (await isWhole(held))) return 'here';
    // The wrong sizes fail on the list.
    for (const file of held ? [held] : sizes) {
      const fetched = await fetchFile(file, peers, mirrors).then(
        () => true,
        () => false,
      );
      if (fetched) return 'fetched';
    }
    return null;
  }

  /**
   * Fetches what this node wants and lacks: the files reads wait for, and
   * every file a version it keeps whole names, unless it was dropped here or
   * is larger than the limits let come ahead. Each is tried at
   * every size named for it. A file nobody had is asked of everyone
   * again, mirrors too, only after `RETRY_MS`; meanwhile of each peer that
   * connects, and, while a read waits for it, of every peer on each pass.
   */
  async function fetchMissing(): Promise<void> {
    const fresh = [...joined];
    joined.clear();
    const named = await namedFiles();
    for (const hash of [...waiting.keys()]) {
      // Its body was superseded meanwhile: nothing here names it to ask for any more.
      if (!named.has(hash)) settle(hash, new Error('No record here names that file'));
    }
    for (const [hash, sizes] of named) {
      if (closed) return;
      const waited = waiting.has(hash);
      const ahead = sizes.filter((file) => file.size <= (config.limits?.ahead ?? Infinity));
      const dropped = async () => !!(await adapter.get(usedKey(hash))) && !(await adapter.get(listKey(hash)));
      if (!waited && (ahead.length === 0 || (await dropped()))) continue;
      const recent = Date.now() - (unfound.get(hash) ?? 0) < RETRY_MS;
      const peers = recent && !waited ? askable().filter((peer) => fresh.includes(peer)) : askable();
      if (recent && peers.length === 0) continue;
      const got = await fetchAny(hash, waited ? sizes : ahead, peers, !recent);
      if (got) {
        unfound.delete(hash);
        settle(hash, null);
        // Within the limit after each file, not only after the pass: a flood never holds more than `keep`.
        if (got === 'fetched' && !waited && config.limits) await dropLeastUsed(config.limits.keep);
      } else if (!recent) unfound.set(hash, Date.now());
    }
  }

  function settle(hash: string, error: Error | null): void {
    waiting.get(hash)?.settle(error);
    waiting.delete(hash);
  }

  /** While a read waits, it is asked for again now and then: a peer may have fetched it since, though nothing here changed */
  function keepAsking(): void {
    if (waitTimer || closed) return;
    waitTimer = setTimeout(() => {
      waitTimer = null;
      void fetchMissing()
        .catch(() => {
          // A store out of reach; asked again next time.
        })
        .finally(() => {
          if (waiting.size > 0) keepAsking();
        });
    }, WAIT_MS);
    unref(waitTimer);
  }

  /** Opens a file a body refers to, waiting for its bytes while no peer or mirror has them */
  async function open(ref: SealedFile): Promise<Uint8Array> {
    for (;;) {
      try {
        return await openFile(await read(ref), ref);
      } catch (error) {
        // A file no version here names, or whose id is here whole yet won't open as named, is never coming.
        const held = await heldFile(ref.hash);
        const never = !(await isNamed(ref)) || (held && (await isWhole(held)));
        // Asked after those, since the space may close meanwhile and a wait made then would never end.
        if (never || closed) throw error;
      }
      let entry = waiting.get(ref.hash);
      if (!entry) {
        let settled: (error: Error | null) => void = () => {};
        const done = new Promise<Error | null>((resolve) => (settled = resolve));
        entry = { done, settle: (error) => settled(error) };
        waiting.set(ref.hash, entry);
        keepAsking();
      }
      const failed = await entry.done;
      if (failed) throw failed;
    }
  }

  return Object.freeze({
    add,
    read,
    open,
    onMessage,
    /** Something changed in the store: which files are named is worked out again */
    changed() {
      named = null;
    },
    /** A peer connected: asked for what nobody had on the next pass, whether or not it answered before */
    joined(peer: string) {
      silent.delete(peer);
      joined.add(peer);
    },
    tidy,
    fetchMissing,
    close() {
      closed = true;
      for (const request of requests.values()) request.settle();
      if (waitTimer) clearTimeout(waitTimer);
      for (const hash of [...waiting.keys()]) settle(hash, new Error('The space is closed'));
    },
  });
}
