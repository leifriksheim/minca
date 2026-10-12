/**
 * 4. Hall of fame. A comment enters it when 5 different members react 🙂.
 * The claim cites the reactions; a reaction withdrawn later, or before
 * the claim, doesn't un-fame it (the plan, §3).
 */
import type { Check } from '../../packages/core/src/records/checks.js';
import type { Host } from '../host/cel-host.js';
import { next, version } from '../host/space.js';

// -- The community: a CEL contract, on a claim that cites the reactions -------------

const claimContract: Check[] = [
  {
    that: "versions(body.reactions).filter(r, r.collection == 'app.reaction' && !r.deleted && r.link('on') == link('on') && r.body.emoji == '🙂').map(r, r.author).distinct().size() >= 5",
    else: "A comment enters the hall of fame with 5 different people's 🙂",
  },
];

// -- The story ---------------------------------------------------------------------

const ALICE = 'did:key:alice';
export const M = [1, 2, 3, 4, 5, 6].map((n) => `did:key:m${n}`);
const m = (i: number) => M[i - 1] ?? '';

export const comment = version({ id: 'c', collection: 'app.comment', author: ALICE, body: { text: 'gg' } });
export const react = (i: number, emoji = '🙂') =>
  version({
    id: `r${i}`,
    collection: 'app.reaction',
    author: m(i),
    body: { emoji },
    links: [{ rel: 'on', to: 'c' }],
    seen: ['c'],
  });
export const reactions = [1, 2, 3, 4, 5].map((i) => react(i));
export const meh = react(6, '😐');
export const claim = (id: string, seen: string[], cites = ['r1', 'r2', 'r3', 'r4', 'r5']) =>
  version({
    id,
    collection: 'app.fame',
    author: ALICE,
    body: { reactions: cites },
    links: [{ rel: 'on', to: 'c' }],
    seen,
  });
export const f1 = claim('f1', ['r1', 'r2', 'r3', 'r4', 'r5']);
export const base = [comment, ...reactions, meh, f1];

/** r3 withdrawn: a delete, after the claim (`seen`) or before it */
export const withdraw = (seen: string[]) => next(react(3), { id: 'd3', body: null, seen });
export const removeM3 = (seen: string[]) =>
  version({ id: 'x3', collection: 'std.member', author: ALICE, body: { op: 'remove', did: m(3) }, seen });

export const host: Host = { founders: [ALICE], members: M, contracts: { 'app.fame': claimContract } };
