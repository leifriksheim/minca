// std.space-profile: how a space presents itself, left by the presets to those who keep order.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { community } from '../src/space/presets.js';
import { spaceProfile } from '../src/schemas/library/social.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { open, person } from './helpers/person.js';
import { hold } from './helpers/hold.js';
import { joined } from './helpers/joined.js';

after(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

describe('std.space-profile', () => {
  test('in a community, a member may not change how the space presents itself, and an admin may', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const admin = (await person(hub)).node;
    const member = (await person(hub)).node;
    const { id: space } = await admin.spaces.create({ name: 'Club', ...community, visibility: 'private' });
    await admin.spaces.assign(space, admin.did, 'admin');
    await admin.collections.define(space, spaceProfile);
    await member.spaces.join(await admin.spaces.invite(space, { role: 'member' }));
    await hold(admin, space);
    await joined(member, space);
    await hold(member, space);

    await assert.rejects(member.records.put(space, spaceProfile, { name: 'Members only' }));
    const set = await admin.records.put(space, spaceProfile, { name: 'The Club', bio: 'Chess on Tuesdays' });
    assert.equal(set.body?.name, 'The Club');
  });
});
