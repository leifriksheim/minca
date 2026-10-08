/**
 * Lasting writer keys on disk, for nodes the CLI runs (spec 02 §4.10).
 *
 * The same idea as `browserWriterKeys` in core: one key per slot, claimed
 * under a lock so two processes never sign with one key, its places in its
 * logs kept beside it. Here a slot is a directory, the lock a file naming the
 * process that holds it, reclaimed once that process is gone.
 *
 * Kept outside the account's data, which may be copied or synced: a key in
 * two places at once forks its log. And sealed under the account's vault
 * key, as the registry is, so a copy of the files can't sign.
 */
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaimedWriter, HeadStore, WriterKeySource } from '@weaveprotocol/core';
import { errorCode, isRecord } from './json.js';

const MAX_SLOTS = 32;
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

/** AES-GCM under the vault key: a 12-byte IV, then the ciphertext */
async function seal(vaultKey: CryptoKey, text: string): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, new TextEncoder().encode(text)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return out;
}

async function unseal(vaultKey: CryptoKey, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const opened = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    vaultKey,
    bytes.subarray(12),
  );
  return new TextDecoder().decode(opened);
}

/** The slot's key pair: made on first claim, then the same every time */
async function keyPair(file: string, vaultKey: CryptoKey): Promise<CryptoKeyPair> {
  const subtle = globalThis.crypto.subtle;
  try {
    const stored: unknown = JSON.parse(await unseal(vaultKey, new Uint8Array(await readFile(file))));
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
  await writeFile(file, await seal(vaultKey, JSON.stringify(jwk)), { mode: 0o600 });
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
 * @param dir One account's slots, e.g. `~/.weave/writers/<account id>`
 * @param vaultKey The account's vault key, which seals each key at rest
 */
export function fileWriterKeys(dir: string, vaultKey: CryptoKey): WriterKeySource {
  return Object.freeze({
    async claim(): Promise<ClaimedWriter | null> {
      for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
        const where = path.join(dir, `slot-${slot}`);
        await mkdir(path.join(where, 'heads'), { recursive: true, mode: 0o700 });
        const lockFile = path.join(where, 'lock');
        if (!(await lock(lockFile))) continue;
        try {
          return Object.freeze({
            keys: await keyPair(path.join(where, 'key.sealed'), vaultKey),
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
