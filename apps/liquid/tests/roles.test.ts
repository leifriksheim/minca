/**
 * Liquid's founding roles (`assemblyRoles`): what stands for one person —
 * whom they follow, what they support, which party they join — only they
 * change, whatever role anyone else holds.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { may, replayAccess, type AccessGenesis } from '../../../packages/core/src/space/roles.js';
import { RECORD_DELETE, RECORD_READ, RECORD_WRITE } from '../../../packages/core/src/space/grants.js';
import { assign } from '../../../packages/core/tests/helpers/access.js';
import { assemblyRoles, delegation, membership, proposal, support } from '../src/schema';

describe('an assembly’s roles', () => {
  const genesis: AccessGenesis = { id: 'space', creator: 'alice', roles: assemblyRoles() };
  const mo = assign('alice', 'mo', 'moderator', []);
  const ann = assign('alice', 'ann', 'admin', [mo.id]);
  const bob = assign('alice', 'bob', 'member', [ann.id]);
  const { current } = replayAccess(genesis, [mo, ann, bob]);

  test('nobody but its writer changes or removes a delegation, support or a membership', () => {
    for (const did of ['mo', 'ann', 'bob'])
      for (const collection of [delegation.name, support.name, membership.name]) {
        for (const cmd of [RECORD_WRITE, RECORD_DELETE])
          assert.ok(
            !may(current, did, cmd, { collection, byCreator: false, body: {} }),
            `${did} ${cmd} ${collection}`,
          );
        assert.ok(
          may(current, did, RECORD_WRITE, { collection, byCreator: true, body: {} }),
          `${did} writes their own`,
        );
      }
  });

  test('moderators still change and remove the rest, and read everything', () => {
    for (const did of ['mo', 'ann']) {
      assert.ok(may(current, did, RECORD_DELETE, { collection: proposal.name, byCreator: false }));
      assert.ok(may(current, did, RECORD_WRITE, { collection: proposal.name, byCreator: false, body: {} }));
      assert.ok(may(current, did, RECORD_READ, { collection: delegation.name }));
    }
    assert.ok(!may(current, 'bob', RECORD_DELETE, { collection: proposal.name, byCreator: false }));
  });
});
