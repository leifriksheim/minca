/**
 * 7. Dev team. A community preset space whose bot, run by its host, answers
 * in chat and works on the team's GitHub (packages/core/docs/bots.md). Who
 * may configure the bot, give it instructions, connect it to GitHub and have
 * it write there is one test (`mayConfigure`): the grant to instruct bots and
 * every role the bot holds. Judged by the library, on a founder's node that
 * holds the space and assigns the roles.
 */
import { community } from '../../packages/core/src/space/presets.js';
import { hold } from '../../packages/core/tests/helpers/hold.js';
import { person } from '../../packages/core/tests/helpers/person.js';
import { mayConfigure } from '../../packages/core/src/schemas/connectors.js';

/** The team: a founder, an admin, a moderator, a member, and the bot, each with the role a test gives it */
export async function devTeam(botRole: 'member' | 'moderator' | 'admin') {
  const founder = await person();
  const [admin, moderator, member, bot] = await Promise.all([person(), person(), person(), person()]);
  const { id: space } = await founder.node.spaces.create({
    name: 'Dev team',
    ...community,
    visibility: 'private',
  });
  await founder.node.spaces.assign(space, admin.node.did, 'admin');
  await founder.node.spaces.assign(space, moderator.node.did, 'moderator');
  await founder.node.spaces.assign(space, member.node.did, 'member');
  await founder.node.spaces.assign(space, bot.node.did, botRole);
  await hold(founder.node, space);
  const configures = (who: { node: { did: string } }) =>
    mayConfigure(founder.node, space, bot.node.did, who.node.did);
  return { founder, admin, moderator, member, bot, space, configures };
}
