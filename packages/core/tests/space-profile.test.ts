// std.space-profile: how a space presents itself, one record per space, left by the presets to those who keep order.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { P2PNode } from '../src/node/types.js';
import { community } from '../src/space/presets.js';
import { spaceProfile, type SpaceProfileRecord } from '../src/schemas/library/social.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { forge, open, person, settle } from './helpers/person.js';
import { hold, letGo } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { until } from './helpers/until.js';

after(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

/** The space's profile as a reader takes it: the one record at the key its own id gives */
async function profileOf(node: P2PNode, space: string) {
  const key = await node.records.onePerKey(space, spaceProfile.name, { space });
  return key ? ((await node.records.get<SpaceProfileRecord>(space, key))?.body ?? null) : null;
}

/** An admin's community space, with someone else in it holding `role` */
async function club(role: 'member' | 'moderator') {
  const hub = createFakeHub({ latencyMs: 1 });
  const admin = (await person(hub)).node;
  const other = await person(hub);
  const { id: space } = await admin.spaces.create({ name: 'Club', ...community, visibility: 'public' });
  await admin.spaces.assign(space, admin.did, 'admin');
  await admin.collections.define(space, spaceProfile);
  await other.node.spaces.join(await admin.spaces.invite(space, { role }));
  await hold(admin, space);
  await joined(other.node, space);
  await hold(other.node, space);
  await until(
    async () => (await other.node.collections.list(space)).some((c) => c.name === spaceProfile.name),
    4000,
    'the definition to reach them',
  );
  return { admin, other, space };
}

describe('std.space-profile', () => {
  test('in a community, a member may not change how the space presents itself, and an admin may', async () => {
    const { admin, other, space } = await club('member');
    await assert.rejects(other.node.records.put(space, spaceProfile, { space, name: 'Members only' }));
    await admin.records.put(space, spaceProfile, { space, name: 'The Club', bio: 'Chess on Tuesdays' });
    assert.equal((await profileOf(admin, space))?.name, 'The Club');
  });

  test("a peer refuses a member's profile forged past their own node's check", async () => {
    const { admin, other, space } = await club('member');
    await admin.records.put(space, spaceProfile, { space, name: 'The Club' });
    await until(
      async () => (await profileOf(other.node, space))?.name === 'The Club',
      4000,
      'the profile to reach them',
    );
    // A chain of their own at the shared key, signed by hand, so their node's own refusal is no part of it.
    const key = (await other.node.records.onePerKey(space, spaceProfile.name, { space }))!;
    await letGo(other.node, space);
    await forge(other, space, {
      author: '',
      collection: spaceProfile.name,
      body: { space, name: 'Hijacked' },
      retain: true,
      version: { key, seq: 0 },
    });
    await hold(other.node, space);
    await settle(800);
    assert.equal((await profileOf(admin, space))?.name, 'The Club');
    assert.ok(!(await admin.records.history(space, key)).some((v) => v.body?.name === 'Hijacked'));
  });

  test("a writer's clock decides nothing: a later edit stands over a profile dated far ahead", async () => {
    const { admin, other: mod, space } = await club('moderator');
    // While a moderator, they write the profile first, dated 2099 by their own clock.
    const body = { space, name: 'Pinned by an ex-moderator' };
    await letGo(mod.node, space);
    await forge(mod, space, {
      author: '',
      collection: spaceProfile.name,
      body,
      createdAt: '2099-01-01T00:00:00.000Z',
      retain: true,
      version: { key: (await mod.node.records.onePerKey(space, spaceProfile.name, body))!, seq: 0 },
    });
    await hold(mod.node, space);
    await until(async () => !!(await profileOf(admin, space)), 4000, 'the profile to reach the admin');

    // Demoted, and the admin changes it: there is one record, and the edit is its next version.
    await admin.spaces.unassign(space, mod.node.did, 'moderator');
    const key = (await admin.records.onePerKey(space, spaceProfile.name, { space }))!;
    await admin.records.update(space, key, { space, name: 'The Club' });
    assert.equal((await profileOf(admin, space))?.name, 'The Club');
    await until(
      async () => (await profileOf(mod.node, space))?.name === 'The Club',
      4000,
      'the edit to reach them',
    );
  });
});
