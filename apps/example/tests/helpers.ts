/**
 * What these tests share with core's: people on a fake hub, by path, the way
 * the CLI's tests reach them. Nothing here is exported by the library.
 */
import { createFakeHub } from '../../../packages/core/tests/helpers/fake-transport.js';
import { person, type Person } from '../../../packages/core/tests/helpers/person.js';
import { hold } from '../../../packages/core/tests/helpers/hold.js';
import { joined } from '../../../packages/core/tests/helpers/joined.js';
import { until as untilWithin } from '../../../packages/core/tests/helpers/until.js';
import { createLocalRootSigner } from '../../../packages/core/src/identity/root-signer.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../../packages/core/src/identity/did.js';
import { AGENT_FACT, team } from '@weaveprotocol/core';

export const waitFor = (check: () => Promise<boolean>, what: string) => untilWithin(check, 4000, what);

/** Alice owns a team space; Bob is an editor there, so he may define collections too */
export async function setup() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Climbing', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  await hold(bob.node, space);
  return { hub, alice, bob, space };
}

/** This person's agent in these spaces: a key whose note grants records only, and says it is an agent's */
export async function agentOf(who: Person, spaces: ReadonlyArray<string>) {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const note = await createLocalRootSigner(who.me, provider).delegate({
    audience: did,
    capabilities: spaces.map((id) => ({ with: `space:${id}`, can: 'expression/*' })),
    expiration: Math.floor(Date.now() / 1000) + 3600,
    facts: [AGENT_FACT],
  });
  return who.node.asAgent({ keys, note: note.encoded });
}
