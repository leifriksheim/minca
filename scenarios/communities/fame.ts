/**
 * 4. Hall of fame. A comment enters it when 5 different members react 🙂.
 * The claim cites the reactions; a reaction withdrawn later, or before
 * the claim, doesn't un-fame it (spec 09 §4). Judged by the library: a
 * founder's node holds the space, and every member signs their own records.
 */
import * as z from 'zod';
import type { Contract } from '../../packages/core/src/records/contracts.js';
import { storedContract } from '../../packages/core/src/records/contract-builder.js';
import { collection } from '../../packages/core/src/schema/collection-def.js';
import type { DefineCollection } from '../../packages/core/src/node/types.js';
import type { Version } from '../../packages/core/src/types.js';
import { communityNode } from '../../packages/core/tests/helpers/community.js';
import type { Person } from '../../packages/core/tests/helpers/person.js';

// -- The community: a contract on a claim that cites the reactions -----------------

const Comment = z.object({ text: z.string() });
const Reaction = z.object({ emoji: z.string() });
const Fame = z.object({ reactions: z.array(z.string()) });

const ELSE = "A comment enters the hall of fame with 5 different people's 🙂";

const on = { on: { to: ['app.comment'], cardinality: 'one' as const } };
const reaction = collection({ name: 'app.reaction', schema: Reaction, links: on });

/** Built in TypeScript, in the collection, typed from the schemas */
const fame = collection({
  name: 'app.fame',
  schema: Fame,
  links: on,
  contract: {
    check: ({ body, cited, link }) => ({
      [ELSE]: cited(body.reactions, reaction)
        .where((r) => r.deleted.not().and(r.link('on').eq(link('on')), r.body.emoji.eq('🙂')))
        .map((r) => r.author)
        .distinct()
        .count()
        .gte(5),
    }),
  },
});
const famous: Contract = storedContract(fame)!.check![0]!;

/** The same, written by hand: the tests check that both give the same verdicts */
const famousByHand: Contract = {
  that: "versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5",
  else: ELSE,
};

export const claimContracts = { built: famous, 'by hand': famousByHand } as const;

const collections = (claim: Contract): DefineCollection[] => [
  { name: 'app.comment', schema: Comment },
  reaction,
  { name: 'app.fame', schema: Fame, links: on, contract: { check: [claim] } },
];

// -- The story ---------------------------------------------------------------------

/** Alice founds it; m1–m6 are members. m1–m5 react 🙂, m6 😐, and Alice claims fame. */
export async function story(claimContract: Contract = famous) {
  const c = await communityNode(6, collections(claimContract));
  const alice = c.founder;
  const m = (i: number): Person => c.members[i - 1]!;
  const comment = await c.sign(alice, { collection: 'app.comment', body: { text: 'gg' } });
  const links = [{ rel: 'on', to: comment.key }];
  const react = (i: number, emoji = '🙂') =>
    c.sign(m(i), { collection: 'app.reaction', body: { emoji }, links });
  const reactions = await Promise.all([1, 2, 3, 4, 5].map((i) => react(i)));
  const meh = await react(6, '😐');
  const claim = (cites: ReadonlyArray<Version>, seen?: ReadonlyArray<string>) =>
    c.sign(alice, {
      collection: 'app.fame',
      body: { reactions: cites.map((r) => r.id) },
      links,
      ...(seen ? { seen } : {}),
    });
  const f1 = await claim(reactions);
  /** A reaction withdrawn: its author's delete */
  const withdraw = (r: Version, i: number) =>
    c.sign(m(i), {
      collection: 'app.reaction',
      body: null,
      deleted: true,
      retain: false,
      version: { key: r.key, seq: 1, prev: r.id, genesis: r.id },
    });
  /** Alice removes a member, having seen everything so far */
  const remove = (i: number) => alice.node.spaces.removeMember(c.space, m(i).node.did);
  return { c, comment, reactions, meh, f1, claim, withdraw, remove };
}
