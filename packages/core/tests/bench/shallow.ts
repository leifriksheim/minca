/**
 * A new device joining a space shaped like an account registry that churned:
 * one record edited HOT times (6000) and R records (100) edited E times (130)
 * each, kept whole by a keeper the space names. Timed until the newcomer
 * reads every record's latest edit, syncing whole, shallow always, and
 * shallow first (then until it holds every version), over links of LATENCY
 * ms (20).
 *
 *   npx tsx --conditions=@minca/source tests/bench/shallow.ts [HOT] [R] [E] [LATENCY] [whole,always,first]
 */
import { team } from '../../src/space/presets.js';
import type { P2PNode, ShallowMode } from '../../src/node/types.js';
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import { createFakeHub } from '../helpers/fake-transport.js';
import { memoryStores } from '../helpers/memory-stores.js';
import { hold } from '../helpers/hold.js';
import { joined } from '../helpers/joined.js';
import { person, ms } from './common.js';

const HOT = Number(process.argv[2] ?? 6000);
const RECORDS = Number(process.argv[3] ?? 100);
const EDITS = Number(process.argv[4] ?? 130);
const LATENCY = Number(process.argv[5] ?? 20);
const LIMIT = 600_000;
const MODES = (process.argv[6] ?? 'whole,always,first').split(',');
const versions = 1 + HOT + RECORDS * (1 + EDITS);

const hub = createFakeHub({ latencyMs: LATENCY });
const alice = await person(hub);
const { id: space } = await alice.spaces.create({ name: 'Registry', ...team, visibility: 'private' });
await hold(alice, space);
await alice.collections.define(space, { name: 'app.seen', schema: { type: 'object' } });
const hot = (await alice.records.put(space, 'app.seen', { n: 0 })).key;
for (let n = 1; n <= HOT; n++) await alice.records.update(space, hot, { n });
const keys: string[] = [];
for (let i = 0; i < RECORDS; i++) keys.push((await alice.records.put(space, 'app.seen', { n: 0 })).key);
for (let n = 1; n <= EDITS; n++) for (const key of keys) await alice.records.update(space, key, { n });

/** Every record's edits added up: equal only once each record's newest version is here */
const total = async (node: P2PNode) =>
  (await node.records.list<{ n: number }>(space, { collection: 'app.seen' })).reduce(
    (sum, record) => sum + (record.body?.n ?? 0) + 1,
    0,
  );
const expected = await total(alice);
async function until(done: () => Promise<boolean>, what: string, since = performance.now()) {
  while (!(await done())) {
    if (performance.now() - since > LIMIT) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const keeperStores = memoryStores();
const keeper = await person(hub, { stores: keeperStores });
await keeper.spaces.join(await alice.spaces.invite(space));
await hold(keeper, space);
await joined(keeper, space, LIMIT);
const versionsIn = async (stores: typeof keeperStores) =>
  (await createStorageProvider(await stores(`spaces/${space}`)).sums()).get('app.seen')?.count ?? 0;
await until(async () => (await versionsIn(keeperStores)) === versions, 'the keeper holding every version');
await alice.spaces.setKeepers(space, [{ did: keeper.sessionDid, name: 'Host' }]);
await until(
  async () => (await keeper.spaces.access(space)).keepers.length > 0,
  'the keeper knowing it keeps',
);
const invite = await alice.spaces.invite(space);
await alice.close();
console.log(`${versions} versions, all at the keeper. A newcomer over ${LATENCY}ms links:`);

const modes = [undefined, 'always', 'first'] satisfies ReadonlyArray<ShallowMode | undefined>;
for (const shallow of modes.filter((mode) => MODES.includes(mode ?? 'whole'))) {
  const stores = memoryStores();
  const node = await person(hub, { stores, ...(shallow ? { shallow } : {}) });
  const t = performance.now();
  await node.spaces.join(invite);
  await hold(node, space);
  await until(async () => (await total(node)) === expected, `${shallow ?? 'whole'} reading the latest`, t);
  let line = `  ${(shallow ?? 'whole').padEnd(6)} reads every latest edit in ${ms(performance.now() - t)}, holding ${await versionsIn(stores)} versions`;
  if (shallow === 'first') {
    await until(async () => (await versionsIn(stores)) === versions, 'first holding every version', t);
    line += `; every version in ${ms(performance.now() - t)}`;
  }
  console.log(line);
  await node.close();
}
await keeper.close();
process.exit(0);
