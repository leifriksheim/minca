/**
 * A `minca mcp` session's agent in a process of its own, for tests that run
 * several: says `LOCAL` or `REMOTE` each time where its node runs changes,
 * and closes on SIGTERM.
 */
import { useAgent } from '../../src/agent.js';

const agent = await useAgent(process.argv[2] ?? '', { network: { transports: () => [] } });
// A borrowed node can't start an agent: that is how it tells.
// eslint-disable-next-line typescript/unbound-method -- read as text, never called
const where = () => (String(agent.node.asAgent).includes('across a port') ? 'REMOTE' : 'LOCAL');
let last = '';
setInterval(() => {
  const now = where();
  if (now !== last) process.stdout.write(`${(last = now)}\n`);
}, 50);
process.once('SIGTERM', () => void agent.close().then(() => process.exit(0)));
