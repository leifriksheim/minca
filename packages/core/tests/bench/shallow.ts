/**
 * A new device joining a space shaped like an account registry that churned:
 * one record edited HOT times (6000) and R records (100) edited E times (130)
 * each, kept whole by a carrier the space names. Timed until the newcomer
 * reads every record's latest edit, syncing whole and shallow, over links of
 * LATENCY ms (20).
 *
 *   npx tsx --conditions=@minca/source tests/bench/shallow.ts [HOT] [R] [E] [LATENCY] [whole,shallow]
 */
import { team } from '../../src/space/presets.js';
import type { P2PNode } from '../../src/node/types.js';
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
const MODES = (process.argv[6] ?? 'whole,shallow').split(',');
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

const carrierStores = memoryStores();
const carrier = await person(hub, { stores: carrierStores });
await carrier.spaces.join(await alice.spaces.invite(space));
await hold(carrier, space);
await joined(carrier, space, LIMIT);
const versionsIn = async (stores: typeof carrierStores) =>
  (await createStorageProvider(await stores(`spaces/${space}`)).sums()).get('app.seen')?.count ?? 0;
await until(async () => (await versionsIn(carrierStores)) === versions, 'the carrier holding every version');
await alice.spaces.setCarriers(space, [{ did: carrier.sessionDid, name: 'Host' }]);
await until(
  async () => (await carrier.spaces.access(space)).carriers.length > 0,
  'the carrier knowing it keeps',
);
const invite = await alice.spaces.invite(space);
await alice.close();
console.log(`${versions} versions, all at the carrier. A newcomer over ${LATENCY}ms links:`);

for (const shallow of [false, true].filter((mode) => MODES.includes(mode ? 'shallow' : 'whole'))) {
  const stores = memoryStores();
  const node = await person(hub, { stores, ...(shallow ? { shallow } : {}) });
  const t = performance.now();
  await node.spaces.join(invite);
  await hold(node, space);
  const mode = shallow ? 'shallow' : 'whole';
  await until(async () => (await total(node)) === expected, `${mode} reading the latest`, t);
  console.log(
    `  ${mode.padEnd(7)} reads every latest edit in ${ms(performance.now() - t)}, holding ${await versionsIn(stores)} versions`,
  );
  await node.close();
}
await carrier.close();
process.exit(0);
