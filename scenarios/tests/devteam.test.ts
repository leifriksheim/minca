/** 7. Dev team: who may configure the team's bot, as its host and the bot itself ask it. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { devTeam } from '../communities/devteam.js';

describe('dev team: configuring the bot', () => {
  test('a member bot: the founder, admins and moderators configure it; a member does not', async () => {
    const t = await devTeam('member');
    assert.ok(await t.configures(t.founder));
    assert.ok(await t.configures(t.admin));
    assert.ok(await t.configures(t.moderator));
    assert.ok(!(await t.configures(t.member)), 'no grant to instruct bots');
  });

  test('an admin bot: a moderator may instruct bots, but not this one, which holds more than they do', async () => {
    const t = await devTeam('admin');
    assert.ok(await t.configures(t.admin));
    assert.ok(!(await t.configures(t.moderator)), 'it would act on GitHub with an admin’s grants for them');
  });

  test('the bot raised to admin later: the moderator who configured it may no longer', async () => {
    const t = await devTeam('member');
    assert.ok(await t.configures(t.moderator));
    await t.founder.node.spaces.assign(t.space, t.bot.node.did, 'admin');
    assert.ok(!(await t.configures(t.moderator)), 'asked again each time, of the roles as they stand');
  });

  test('an admin who loses the role loses the bot with it', async () => {
    const t = await devTeam('member');
    await t.founder.node.spaces.unassign(t.space, t.admin.node.did, 'admin');
    assert.ok(!(await t.configures(t.admin)));
  });

  test('the bot can’t configure itself, even holding the grant to instruct bots', async () => {
    const t = await devTeam('member');
    assert.ok(!(await t.configures(t.bot)), 'a member bot holds no grant to instruct bots');
    const strong = await devTeam('admin');
    assert.ok(
      !(await strong.configures(strong.bot)),
      'an admin bot: steered once, it would leave itself orders',
    );
  });
});
