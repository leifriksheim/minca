/**
 * What the MCP service's session nodes may hold, and where they may connect
 * (`network.reach`): the nodes, relays and hosts their invites and spaces
 * name, on the public internet only, and the operator's own. Anyone can make
 * an account and write a grant, so none may make the service dial itself,
 * its network, or the cloud's metadata address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicNode } from '../src/remote-mcp/reach.js';
import { boundedMemory } from '../src/remote-mcp/memory.js';

test('only addresses over TLS, at public addresses', async () => {
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
    'wss://[64:ff9b::7f00:1]/peer',
    'wss://[64:ff9b:1::1]/peer',
    'wss://localhost/peer',
    'not an address',
  ])
    assert.equal(await publicNode(node), false, node);
  assert.equal(await publicNode('wss://1.1.1.1/peer#did:key:z'), true);
  assert.equal(await publicNode('https://1.1.1.1'), true, 'a host it asks about itself');
  assert.equal(await publicNode('http://1.1.1.1'), false);
  assert.equal(await publicNode('wss://[2606:4700:4700::1111]/peer'), true);
  assert.equal(await publicNode('wss://[64:ff9b::101:101]/peer'), true, 'DNS64 for a public IPv4 address');
});

test('a session’s node holds no more than its budget: a stranger’s space can’t grow it without end', async () => {
  const memory = boundedMemory(10_000);
  const one = await memory.stores('spaces/a');
  const two = await memory.stores('spaces/b');
  await one.put('x', new Uint8Array(6000));
  // Every store of the session counts toward it.
  await assert.rejects(two.put('y', new Uint8Array(6000)), /holds more than/);
  // What goes makes room again.
  await one.delete('x');
  await two.put('y', new Uint8Array(6000));
  // So does a space closed for good: opened again, it starts empty.
  memory.drop('spaces/b');
  assert.equal(memory.used(), 0);
  assert.equal(await (await memory.stores('spaces/b')).get('y'), null);
});
