/**
 * Lasting writer keys on disk, for nodes the CLI runs (spec 02 §4.10).
 *
 * The same idea as `browserWriterKeys` in core: one key per slot, claimed
 * under a lock so two processes never sign with one key, its places in its
 * logs kept beside it. Here a slot is a directory, the lock numbered files
 * naming the process that holds it, taken over once that process is gone.
 *
 * Kept outside the account's data, which may be copied or synced: a key in
 * two places at once forks its log. And sealed under the account's local
 * key, as the registry is, bound to the account and the slot, so a copy of
 * the files can't sign, and a key file moved to another slot doesn't open.
 */
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  openEnvelope,
  sealEnvelope,
  type ClaimedWriter,
  type HeadStore,
  type WriterKeySource,
} from '@minca/core';
import { errorCode, isRecord } from './json.js';

const MAX_SLOTS = 32;
/** The envelope label of a writer key on disk; bound to `{ did, slot }` */
const WRITER_KEY_LABEL = 'minca/writer-key/v1';

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

/**
 * Holds a lock for this process, or gives null when another running process
 * holds it. A lock left by a process that is gone is taken over.
 */
export async function holdLock(file: string): Promise<(() => Promise<void>) | null> {
  const mine = await lock(file);
  return mine ? () => letGo(mine) : null;
}

/** A lock's numbers, highest first: each `<file>.<n>` names the process that took it */
async function numbers(file: string): Promise<number[]> {
  const prefix = `${path.basename(file)}.`;
  const names = await readdir(path.dirname(file)).catch(() => []);
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .sort((a, b) => b - a);
}

/** What a lock file says once its process lets go of it */
const RELEASED = 'released';

/** The running process that holds a lock, or null when none does */
export async function lockHolder(file: string): Promise<number | null> {
  const [top] = await numbers(file);
  if (top === undefined) return null;
  const holder = Number((await readFile(`${file}.${top}`, 'utf8').catch(() => '')).trim());
  return Number.isSafeInteger(holder) && holder > 0 && alive(holder) ? holder : null;
}

/**
 * Whether a lock file is free to take over: let go of, or left by a process
 * that is gone. One that is empty or can't be read is held, so two never
 * both take it.
 */
async function free(file: string): Promise<boolean> {
  const text = (await readFile(file, 'utf8').catch(() => '')).trim();
  const holder = Number(text);
  return text === RELEASED || (Number.isSafeInteger(holder) && holder > 0 && !alive(holder));
}

/** Links a file into place, or creates it there where the disk has no hard links (exFAT, some network mounts) */
async function linkOrCreate(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(errorCode(error)))) throw error;
    // Seen empty for a moment, which reads as held.
    await writeFile(to, await readFile(from), { flag: 'wx', mode: 0o600 });
  }
}

/** Puts `text` at `file` whole: written to a file of its own, then moved or linked there */
async function putWhole(file: string, text: string, place: (from: string, to: string) => Promise<void>) {
  const whole = `${file}.writing-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(whole, text, { mode: 0o600 });
  try {
    await place(whole, file);
  } finally {
    await rm(whole, { force: true });
  }
}

/** Lets go of a lock, keeping its number: none is used twice */
const letGo = (mine: string) => putWhole(mine, RELEASED, rename);

/**
 * Takes a lock, or says another running process holds it: the path this
 * process holds it by, or null. The lock is its highest number, and numbers
 * only grow: each is linked into place whole, one above a number that is
 * free, and kept when let go of, so only one process ever gets each. One
 * that got a lower number while another got a higher steps back.
 */
async function lock(file: string): Promise<string | null> {
  // A minca from before the numbered lock holds the bare file, and reads no other.
  const older = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  if (Number.isSafeInteger(older) && older > 0 && alive(older)) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // One look decides: the number this one takes is above the one it saw free.
    const [top = -1] = await numbers(file);
    if (top >= 0 && !(await free(`${file}.${top}`))) return null;
    const mine = `${file}.${top + 1}`;
    try {
      await putWhole(mine, String(process.pid), linkOrCreate);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      continue;
    }
    const [highest] = await numbers(file);
    if (highest === top + 1) {
      // Those below are free, or stepping back; this one's number stays above them.
      for (const below of await numbers(file))
        if (below < top + 1) await rm(`${file}.${below}`, { force: true });
      return mine;
    }
    await rm(mine, { force: true });
  }
  return null;
}

/** Where a sealed key belongs: whose it is, and which slot */
interface Slot {
  readonly localKey: CryptoKey;
  readonly did: string;
  readonly slot: number;
}

const sealKey = (where: Slot, text: string) =>
  sealEnvelope(
    where.localKey,
    WRITER_KEY_LABEL,
    { did: where.did, slot: where.slot },
    new TextEncoder().encode(text),
  );

async function openKey(where: Slot, bytes: Uint8Array): Promise<string> {
  const opened = await openEnvelope(
    where.localKey,
    WRITER_KEY_LABEL,
    { did: where.did, slot: where.slot },
    bytes,
  );
  if (!opened) throw new Error(`The writer key in slot ${where.slot} is not this account's, or was changed`);
  return new TextDecoder().decode(opened);
}

/** The slot's key pair: made on first claim, then the same every time */
async function keyPair(file: string, where: Slot): Promise<CryptoKeyPair> {
  try {
    const kept = await importKeyJwk(JSON.parse(await openKey(where, new Uint8Array(await readFile(file)))));
    if (kept) return kept;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const made = await newKey();
  await writeFile(file, await sealKey(where, JSON.stringify(made.jwk)), { mode: 0o600 });
  return made.keys;
}

/** Each place in its own file, written whole or not at all */
function headStore(dir: string): HeadStore {
  const fileOf = (key: string) => path.join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key) {
      try {
        return new Uint8Array(await readFile(fileOf(key)));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key, value) {
      const file = fileOf(key);
      await writeFile(`${file}.tmp`, value);
      await rename(`${file}.tmp`, file);
    },
  };
}

/**
 * Lasting writer keys in a directory of slots.
 * @param dir One account's slots, e.g. `~/.minca/writers/<account id>`
 * @param localKey The account's local key (`deriveLocalKey`), which seals each key at rest
 * @param did The account's DID, which each sealed key is bound to
 */
export function fileWriterKeys(dir: string, localKey: CryptoKey, did: string): WriterKeySource {
  return Object.freeze({
    async claim(): Promise<ClaimedWriter | null> {
      for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
        const where = path.join(dir, `slot-${slot}`);
        await mkdir(path.join(where, 'heads'), { recursive: true, mode: 0o700 });
        const lockFile = await lock(path.join(where, 'lock'));
        if (!lockFile) continue;
        try {
          const sealed = path.join(where, 'key.sealed');
          // A new key starts new lines: whatever a forgotten one left goes.
          const missing = await stat(sealed).then(
            () => false,
            (error: unknown) => {
              // Only a key that isn't there: another failure must not cost a key its places.
              if (errorCode(error) === 'ENOENT') return true;
              throw error;
            },
          );
          if (missing) {
            await rm(path.join(where, 'heads'), { recursive: true, force: true });
            await mkdir(path.join(where, 'heads'), { recursive: true, mode: 0o700 });
          }
          return Object.freeze({
            keys: await keyPair(sealed, { localKey, did, slot }),
            heads: headStore(path.join(where, 'heads')),
            async release() {
              await letGo(lockFile);
            },
            // A revoked key: the slot's next claim makes a new one, with lines of its own.
            // Its places stay while it may still sign this run.
            async forget() {
              await rm(sealed, { force: true });
            },
          });
        } catch (error) {
          await letGo(lockFile);
          throw error;
        }
      }
      return null;
    },
  });
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

/** A new P-256 key pair: the JWK a file keeps of it, and the keys, the private one not exportable */
export async function newKey(): Promise<{
  jwk: Record<'privateKey' | 'publicKey', JsonWebKey>;
  keys: CryptoKeyPair;
}> {
  const subtle = globalThis.crypto.subtle;
  const made = await subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const jwk = {
    privateKey: await subtle.exportKey('jwk', made.privateKey),
    publicKey: await subtle.exportKey('jwk', made.publicKey),
  };
  const privateKey = await subtle.importKey('jwk', jwk.privateKey, ALGORITHM, false, ['sign']);
  return { jwk, keys: { privateKey, publicKey: made.publicKey } };
}

/** A kept key pair, used here only as a key that can't be exported; null when it isn't one. importKey checks the rest. */
export async function importKeyJwk(stored: unknown): Promise<CryptoKeyPair | null> {
  if (!isRecord(stored) || !isRecord(stored.privateKey) || !isRecord(stored.publicKey)) return null;
  const subtle = globalThis.crypto.subtle;
  return {
    privateKey: await subtle.importKey('jwk', stored.privateKey, ALGORITHM, false, ['sign']),
    publicKey: await subtle.importKey('jwk', stored.publicKey, ALGORITHM, true, ['verify']),
  };
}
