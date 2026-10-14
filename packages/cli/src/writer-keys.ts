/**
 * Lasting writer keys on disk, for nodes the CLI runs (spec 02 §4.10).
 *
 * The same idea as `browserWriterKeys` in core: one key per slot, claimed
 * under a lock so two processes never sign with one key, its places in its
 * logs kept beside it. Here a slot is a directory, the lock a file naming the
 * process that holds it, reclaimed once that process is gone.
 *
 * Kept outside the account's data, which may be copied or synced: a key in
 * two places at once forks its log. And sealed under the account's local
 * key, as the registry is, bound to the account and the slot, so a copy of
 * the files can't sign, and a key file moved to another slot doesn't open.
 */
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  return (await lock(file)) ? () => rm(file, { force: true }) : null;
}

/** Takes a slot's lock, or says another running process holds it */
async function lock(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const holder = Number((await readFile(file, 'utf8').catch(() => '')).trim());
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) return false;
      // Left by a process that is gone.
      await rm(file, { force: true });
    }
  }
  return false;
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
        const lockFile = path.join(where, 'lock');
        if (!(await lock(lockFile))) continue;
        try {
          return Object.freeze({
            keys: await keyPair(path.join(where, 'key.sealed'), { localKey, did, slot }),
            heads: headStore(path.join(where, 'heads')),
            async release() {
              await rm(lockFile, { force: true });
            },
            // A revoked key: the slot's next claim makes a new one, with lines of its own.
            async forget() {
              await rm(path.join(where, 'key.sealed'), { force: true });
              await rm(path.join(where, 'heads'), { recursive: true, force: true });
              await mkdir(path.join(where, 'heads'), { recursive: true, mode: 0o700 });
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
