/** A key given records only in one space is not taken as its account in another, so it can't speak in calls there (packages/calls/README.md). */ import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveMessage, P2PNode } from '../src/node/types.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { utf8Encode } from '../src/utils/encoding.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { team } from '../src/space/presets.js';
import { until } from './helpers/until.js';
import { person } from './helpers/person.js';

function inbox(node: P2PNode): Array<LiveMessage & { space: string }> {
  const heard: Array<LiveMessage & { space: string }> = [];
  node.subscribe((event) => {
    if (event.type === 'message') heard.push(event);
  });
  return heard;
}

test('a records-only note for another space is not recordsOnly here', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub, { accountKey: true });
  const { id: space } = await alice.node.spaces.create({ name: 'Open', ...team, visibility: 'public' });
  await alice.node.spaces.hold(space);
  const heard = inbox(alice.node);
  const provider = alice.manager.getProvider();
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  // What the home signs for a program given records in one chosen space (scope: spaces).
  const note = await createLocalRootSigner(alice.me, provider).delegate({
    audience: did,
    command: '/record',
    subject: 'space:bsomewhereelse',
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const wire = hub.transport(did, space);
  await wire.connect?.();
  await until(async () => (await alice.node.spaces.status(space)).peers.includes(did), 4000, 'connect');
  const say = (type: string, payload: unknown) =>
    wire.send(alice.node.sessionDid, utf8Encode(JSON.stringify({ type, from: did, payload })));
  say('who', { note });
  say('live', { type: 'hello' });
  await until(() => heard.some((m) => m.peer === did), 4000, 'message');
  const message = heard.find((m) => m.peer === did)!;
  assert.equal(message.from, alice.node.did, 'speaks as the account');
  assert.equal(message.recordsOnly, true, 'a records-only program must not pass the calls gate');
  wire.closeAll();
});
