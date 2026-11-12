/**
 * What coming back costs: an account with S spaces of R records each, E edits
 * a record, and A edits to one record of its registry, closed and started
 * again over the same stores, L more spaces having been left. Times the start
 * and the first list of each space, and counts the reads each asks of its
 * stores: in a browser every one is a turn through IndexedDB.
 *
 *   npx tsx --conditions=@minca/source tests/bench/restart.ts [S] [R] [E] [A] [L]
 */
import { createNode } from '../../src/node/node.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { deriveAccountKey } from '../../src/identity/account-vault.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { community } from '../../src/space/presets.js';
import { memoryStores } from '../helpers/memory-stores.js';
import type { StoreFactory } from '../../src/node/stores.js';
import { time, ms } from './common.js';

let reads = 0;

const [S, R, E, A, L] = [2, 3, 4, 5, 6].map((at, i) => Number(process.argv[at] ?? [5, 200, 0, 0, 0][i]));

const manager = createIdentityManager();
const seed = generateSeed();
const config = {
  signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
  accountKey: await deriveAccountKey(seed),
  stores: countingReads(memoryStores()),
  watchIntervalMs: 0,
};

/** The same stores, counting what is read from them */
function countingReads(stores: StoreFactory): StoreFactory {
  const counted = <T>(answer: T): T => {
    reads++;
    return answer;
  };
  return async (path, options) => {
    const adapter = await stores(path, options);
    return {
      ...adapter,
      get: (key) => counted(adapter.get(key)),
      list: (prefix) => counted(adapter.list(prefix)),
      getVersion: (id) => counted(adapter.getVersion(id)),
      ...(adapter.entries ? { entries: (prefix: string) => counted(adapter.entries!(prefix)) } : {}),
      ...(adapter.getVersions
        ? { getVersions: (ids: ReadonlyArray<string>) => counted(adapter.getVersions!(ids)) }
        : {}),
    };
  };
}

/** Milliseconds and store reads `run` takes */
async function cost(run: () => Promise<unknown>): Promise<string> {
  const before = reads;
  const took = await time(run);
  return `${ms(took)}\t${reads - before} reads`;
}

const first = await createNode(config);
const spaces: string[] = [];
for (let s = 0; s < S; s++) {
  const { id } = await first.spaces.create({ name: `Space ${s}`, ...community, visibility: 'private' });
  await first.collections.define(id, {
    name: 'app.note',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  });
  for (let r = 0; r < R; r++) {
    const { key } = await first.records.put(id, 'app.note', { text: `note ${r}` });
    for (let e = 0; e < E; e++) await first.records.update(id, key, { text: `note ${r}, edit ${e}` });
  }
  spaces.push(id);
}
for (let l = 0; l < L; l++) {
  const { id } = await first.spaces.create({ name: `Left ${l}`, ...community, visibility: 'private' });
  await first.spaces.leave(id);
}
const registry = (await first.account.space())!;
const looked = await first.records.put(registry, 'app.looked', { at: 0 });
for (let a = 1; a <= A; a++) await first.records.update(registry, looked.key, { at: a });
await first.close();

console.log(
  `${S} spaces, ${R} records each, ${E} edits a record, ${A} edits in the registry, ${L} spaces left`,
);
let back!: Awaited<ReturnType<typeof createNode>>;
console.log(`start\t${await cost(async () => (back = await createNode(config)))}`);
console.log(`list spaces\t${await cost(() => back.spaces.list())}`);
console.log(
  `first space, first list\t${await cost(() => back.records.list(spaces[0]!, { collection: 'app.note' }))}`,
);
console.log(
  `first space, list again\t${await cost(() => back.records.list(spaces[0]!, { collection: 'app.note' }))}`,
);
console.log(
  `the other spaces, first list\t${await cost(() => Promise.all(spaces.slice(1).map((id) => back.records.list(id, { collection: 'app.note' }))))}`,
);
await back.close();
process.exit(0);
