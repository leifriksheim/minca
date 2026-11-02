/**
 * What the MCP service's session nodes may hold, and where they may connect: the always-on nodes a
 * grant's invites name, on the public internet only, and the operator's own.
 * Anyone can make an account and write a grant, so an invite must never make
 * the service dial itself, its network, or the cloud's metadata address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Grant } from '@minca/core/session';
import { nodesFor, publicNode } from '../src/remote-mcp/reach.js';
import { boundedMemory } from '../src/remote-mcp/memory.js';

test('only nodes over TLS at public addresses', async () => {
  for (const node of [
    'ws://1.1.1.1/peer',
    'wss://127.0.0.1/peer',
    'wss://10.0.0.5/peer',
    'wss://169.254.169.254/peer',
    'wss://192.168.1.1/peer',
    'wss://100.64.0.1/peer',
    'wss://[::1]/peer',
    'wss://[fd00::1]/peer',
    'wss://[fe80::1]/peer',
    'wss://[::ffff:127.0.0.1]/peer',
    'wss://localhost/peer',
    'not an address',
  ])
    assert.equal(await publicNode(node), false, node);
  assert.equal(await publicNode('wss://1.1.1.1/peer#did:key:z'), true);
  assert.equal(await publicNode('wss://[2606:4700:4700::1111]/peer'), true);
});

test('a grant’s invites add the nodes they name that may be reached, after the operator’s own', async () => {
  const invite = (nodes: ReadonlyArray<string>) => {
    // An invitation is a loose version: what matters here is its body's nodes.
    const version = { collection: 'sys.invitation', body: { space: { id: 's', name: 'S' }, nodes } };
    return Buffer.from(JSON.stringify(version)).toString('base64url');
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only `spaces` is read
  const grant = {
    spaces: [
      { id: 'a', name: 'A', invite: invite(['wss://public.example/peer', 'wss://inside.example/peer']) },
      { id: 'b', name: 'B', invite: 'not an invite' },
    ],
  } as unknown as Grant;
  const may = async (node: string) => node.startsWith('wss://public.');
  assert.deepEqual(await nodesFor(grant, ['wss://operator.example/peer'], may), [
    'wss://operator.example/peer',
    'wss://public.example/peer',
  ]);
});

test('a session’s node holds no more than its budget: a stranger’s space can’t grow it without end', async () => {
  const stores = boundedMemory(10_000);
  const one = await stores('spaces/a');
  const two = await stores('spaces/b');
  await one.put('x', new Uint8Array(6000));
  // Every store of the session counts toward it.
  await assert.rejects(two.put('y', new Uint8Array(6000)), /holds more than/);
  // What goes makes room again.
  await one.delete('x');
  await two.put('y', new Uint8Array(6000));
});
