import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { P2PNode } from '@minca/core';

// This browser's storage and address, which the links this device made are kept in and built from.
const kept = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  },
  location: { origin: 'https://app.example', pathname: '/' },
});
const { createInviteLink, madeLinks } = await import('../src/spaces');

/** A node whose space has `arrives` open by the second time it is asked: someone else's, made meanwhile */
function nodeWhere(arrives: ReadonlyArray<{ key: string; role: string }>): P2PNode {
  let asked = 0;
  const node = {
    spaces: {
      access: async () => ({ invites: asked++ === 0 ? [] : arrives.map((one) => ({ ...one, open: true })) }),
      invite: async () => 'SHORTCODE',
    },
  };
  // eslint-disable-next-line typescript/consistent-type-assertions -- two methods of a node are all createInviteLink calls
  return node as unknown as P2PNode;
}

test("a view-only link is never kept as another member's invite that arrived while it was made", async () => {
  // A view-only link writes no invite of its own, so the one new key is Bob's editor invite.
  await createInviteLink(nodeWhere([{ key: 'did:key:bobs-editor-invite', role: 'editor' }]), 'space-1', null);
  assert.deepEqual(madeLinks('space-1'), {});
});

test('a link for a role is kept under its own invite, to copy again', async () => {
  const link = await createInviteLink(
    nodeWhere([{ key: 'did:key:my-member-invite', role: 'member' }]),
    'space-2',
    'member',
  );
  assert.equal(madeLinks('space-2')['did:key:my-member-invite'], link);
});
