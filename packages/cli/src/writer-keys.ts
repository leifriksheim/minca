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
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };

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
 * Holds a lock file for this process, or gives null when another running
 * process holds it. A lock left by a process that is gone is taken over.
 */
export async function holdLock(file: string): Promise<(() => Promise<void>) | null> {
  const mine = await lock(file);
  return mine ? () => rm(mine, { force: true }) : null;
}

/** The running process a file names, or null */
async function runningIn(file: string): Promise<number | null> {
  const holder = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  return Number.isSafeInteger(holder) && holder > 0 && alive(holder) ? holder : null;
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

/** The running process that holds a lock, or null when none does */
export async function lockHolder(file: string): Promise<number | null> {
  // The file itself, as a minca from before numbered locks kept it, counts while that process runs.
  const before = await runningIn(file);
  if (before !== null) return before;
  const [top] = await numbers(file);
  return top === undefined ? null : runningIn(`${file}.${top}`);
}

/**
 * Whether a lock file was left by a process that is gone. One that is empty
 * or can't be read is let go of as it is read, or an older minca is writing
 * it: held, so two never both take it.
 */
async function leftBehind(file: string): Promise<boolean> {
  const holder = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  return Number.isSafeInteger(holder) && holder > 0 && !alive(holder);
}

/**
 * Takes a lock, or says another running process holds it: the path this
 * process holds it by, or null. A stale lock is never removed to take it, so
 * two processes that find it can't both take it. The lock is its highest
 * number: each is linked into place whole, one above a number left behind,
 * so only one process gets each, and one that got a lower number while
 * another got a higher steps back.
 */
async function lock(file: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await stat(file).then(
      () => true,
      () => false,
    );
    if (before && !(await leftBehind(file))) return null;
    // One look decides: the number this one takes is above the one it saw left behind.
    const [top = -1] = await numbers(file);
    if (top >= 0 && !(await leftBehind(`${file}.${top}`))) return null;
    const mine = `${file}.${top + 1}`;
    const whole = `${file}.taking-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(whole, String(process.pid), { mode: 0o600 });
    try {
      await link(whole, mine);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      continue;
    } finally {
      await rm(whole, { force: true });
    }
    const [highest] = await numbers(file);
    if (highest === top + 1) {
      // Those below were left by processes that are gone, or are stepping back.
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
  const subtle = globalThis.crypto.subtle;
  try {
    const stored: unknown = JSON.parse(await openKey(where, new Uint8Array(await readFile(file))));
    if (isRecord(stored) && isRecord(stored.privateKey) && isRecord(stored.publicKey))
      return {
        privateKey: await subtle.importKey('jwk', stored.privateKey, algorithm, false, ['sign']),
        publicKey: await subtle.importKey('jwk', stored.publicKey, algorithm, true, ['verify']),
      };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const made = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = {
    privateKey: await subtle.exportKey('jwk', made.privateKey),
    publicKey: await subtle.exportKey('jwk', made.publicKey),
  };
  await writeFile(file, await sealKey(where, JSON.stringify(jwk)), { mode: 0o600 });
  return {
    privateKey: await subtle.importKey('jwk', jwk.privateKey, algorithm, false, ['sign']),
    publicKey: made.publicKey,
  };
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
              await rm(lockFile, { force: true });
            },
            // A revoked key: the slot's next claim makes a new one, with lines of its own.
            // Its places stay while it may still sign this run.
            async forget() {
              await rm(sealed, { force: true });
            },
          });
        } catch (error) {
          await rm(lockFile, { force: true });
          throw error;
        }
      }
      return null;
    },
  });
}
