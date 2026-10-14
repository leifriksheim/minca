/**
 * `minca carry`: a carrier that keeps one account's spaces online from a
 * folder, as the Chrome extension does from a browser (`apps/extension`). It
 * holds a pass for each space and nothing that reads or writes them
 * (`createCarrierNode` in `packages/core/src/node/carrier.ts`).
 *
 * The folder holds its key (`carrier-key`), the carry grant the account home
 * gave that key (`carry-grant.json`), and what it carries (`store/`). The
 * grant comes from whatever connected it, through a home's window: the
 * desktop app (`apps/desktop`) writes it. This only reads it.
 *
 * It listens on no port. It meets the account's devices through relays, like
 * the extension, so nothing else on this machine can use it.
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCarrierNode, folderStores } from '@minca/core';
import type { CarryGrant } from '@minca/core/session';
import { openFsDirectory } from './fs-directory.js';
import { configuredRelays, enableWebRTC } from './agent.js';
import { hostKey } from './host-setup.js';

export const CARRY_GRANT_FILE = 'carry-grant.json';

/** The carrier's key: made once in the folder, readable by this user alone (the same file a host keeps) */
export const carrierKey = (data: string) => hostKey(data, 'carrier-key');

/** What it says on stdout, one JSON line per change, for whatever started it */
export type CarryStatus =
  | { readonly state: 'not-connected' }
  | { readonly state: 'carrying'; readonly account: string; readonly name: string; readonly spaces: number }
  | { readonly state: 'removed' }
  | { readonly state: 'error'; readonly error: string }
  /**
   * A record arrived that one of the account's wakes asks about, as far as a
   * carrier can tell from outside: which space, which kind of record, and
   * where to open it. Not what it says. For whatever started it to show.
   */
  | {
      readonly state: 'wake';
      readonly space: string;
      readonly collection: string;
      readonly at: string;
      readonly open?: string;
    };

function isCarryGrant(value: unknown): value is CarryGrant {
  if (typeof value !== 'object' || value === null) return false;
  const carry: unknown = Reflect.get(value, 'carry');
  return (
    Reflect.get(value, 'kind') === 'carry' &&
    typeof Reflect.get(value, 'did') === 'string' &&
    typeof carry === 'object' &&
    carry !== null &&
    typeof Reflect.get(carry, 'invite') === 'string'
  );
}

/** The grant in the folder, or null when there is none yet */
async function readCarryGrant(data: string): Promise<CarryGrant | null> {
  let text: string;
  try {
    text = await readFile(path.join(data, CARRY_GRANT_FILE), 'utf8');
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isCarryGrant(parsed)) throw new Error(`${CARRY_GRANT_FILE} is not a carry grant.`);
  return parsed;
}

export async function runCarrier(options: {
  readonly data: string;
  readonly status: (status: CarryStatus) => void;
  readonly log: (line: string) => void;
}): Promise<{ close(): Promise<void> } | null> {
  const { data, status, log } = options;
  const grant = await readCarryGrant(data);
  if (!grant) {
    status({ state: 'not-connected' });
    return null;
  }
  await enableWebRTC().catch(() => log('no WebRTC here: reaching devices through sockets only'));
  const key = await carrierKey(data);
  const relays = [...new Set([...configuredRelays(), ...(grant.relays ?? [])])];
  const node = await createCarrierNode({
    key,
    account: grant.did,
    carry: grant.carry.invite,
    stores: folderStores(await openFsDirectory(path.join(data, 'store'))),
    network: { relays },
  });
  log(`carrying for ${grant.name} (${grant.did}) as ${node.did}`);

  let reported = -1;
  const report = async () => {
    const spaces = (await node.spaces().catch(() => [])).filter((space) => !space.carry).length;
    if (spaces === reported) return;
    reported = spaces;
    status({ state: 'carrying', account: grant.did, name: grant.name, spaces });
  };
  let soon: ReturnType<typeof setTimeout> | null = null;
  node.subscribe((event) => {
    if (event.type === 'wake') {
      status({
        state: 'wake',
        space: event.space.name,
        collection: event.record.collection,
        at: event.record.createdAt,
        ...(event.wake.open ? { open: event.wake.open } : {}),
      });
      return;
    }
    if (event.type === 'closed') {
      // The account took this carrier off: what it carried is no longer its to keep.
      log('the account removed this carrier');
      void node
        .close()
        .then(() => rm(path.join(data, CARRY_GRANT_FILE), { force: true }))
        .then(() => rm(path.join(data, 'store'), { recursive: true, force: true }))
        .then(() => status({ state: 'removed' }));
      return;
    }
    soon ??= setTimeout(() => {
      soon = null;
      void report();
    }, 250);
  });
  await report();
  return {
    close: async () => {
      if (soon) clearTimeout(soon);
      await node.close();
    },
  };
}
