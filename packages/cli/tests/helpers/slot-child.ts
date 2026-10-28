/**
 * A session starting the agent, for tests that race several: says `ready`,
 * reads the time to start at, claims a slot then and says which. Given a
 * space, the session on a connected slot writes five records there first.
 * It keeps the slot until stdin closes.
 */
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeHub } from '../../../core/tests/helpers/fake-transport.js';
import { claimSlot, isConnected, startAgentNode } from '../../src/agent.js';
import { onHub } from './nodes.js';

const [home = '', space] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
process.stdout.write('ready\n');
const at = Number((await lines.next()).value);
await delay(Math.max(0, at - Date.now()));
const slot = await claimSlot(home);
if (space && (await isConnected(slot))) {
  // Alone on a hub of its own: what it signs reaches peers through the shared folder.
  const agent = await startAgentNode(home, slot, { network: onHub(createFakeHub({ latencyMs: 1 })) });
  for (let i = 0; i < 5; i += 1)
    await agent.node.records.put(space, 'app.note', { text: `${process.pid} ${i}` });
  await agent.close();
}
process.stdout.write(`${slot.dir}\n`);
await lines.next();
await slot.release();
