/**
 * The network tab's peers, grouped by whom they act for: every device of
 * yours under you, each member's under them, carriers and servers alone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceStatus } from '@minca/core';

import { groupPeers } from '../src/derive/network';

const status = (fields: Partial<SpaceStatus>): SpaceStatus => ({
  space: 'space',
  connection: 'connected',
  peers: [],
  own: [],
  carriers: [],
  accounts: {},
  fingerprint: '',
  rejected: 0,
  holds: 'all',
  pending: 0,
  ...fields,
});

describe('groupPeers', () => {
  test('your devices are one group under your account, whether they showed it or follow your registry', () => {
    const groups = groupPeers(
      status({
        peers: ['laptop', 'phone', 'chrome', 'mac'],
        own: ['laptop'],
        accounts: { phone: 'did:me' },
        carriers: ['chrome', 'mac'],
      }),
      'did:me',
    );
    assert.deepEqual(groups, [
      { kind: 'mine', did: 'did:me', peers: ['laptop', 'phone'] },
      { kind: 'carrier', did: 'chrome', peers: ['chrome'] },
      { kind: 'carrier', did: 'mac', peers: ['mac'] },
    ]);
  });

  test("a member's devices gather under them; servers that didn't say whose they are stand alone", () => {
    const groups = groupPeers(
      status({
        peers: ['stray', 'a1', 'b1', 'a2', 'other'],
        accounts: { a1: 'did:alice', a2: 'did:alice', b1: 'did:bob' },
      }),
      'did:me',
    );
    assert.deepEqual(groups, [
      { kind: 'person', did: 'did:alice', peers: ['a1', 'a2'] },
      { kind: 'person', did: 'did:bob', peers: ['b1'] },
      { kind: 'server', did: 'stray', peers: ['stray'] },
      { kind: 'server', did: 'other', peers: ['other'] },
    ]);
  });
});
