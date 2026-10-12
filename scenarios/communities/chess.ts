/**
 * 1. Chess club. Members play, and may delete their own moves; a Referee
 * may delete any move in `app.chess`; admins assign Referee, but not to
 * themselves, and take it away. Admins appoint Moderators, who may remove
 * members but not admins (a policy on `.roles`, the target's roles).
 */
import type { Check } from '../../packages/core/src/records/checks.js';
import type { Assignment, Delegation } from '../host/grants.js';
import { version } from '../host/space.js';

export const ALICE = 'did:key:alice'; // founder
export const ERIN = 'did:key:erin'; // admin
export const BOB = 'did:key:bob';
export const CAROL = 'did:key:carol';
export const DAVE = 'did:key:dave'; // referee
export const FRANK = 'did:key:frank';
export const MO = 'did:key:mo'; // moderator, appointed by Erin

// -- The community: UCAN grants, a CEL contract ---------------------------------

export const grants: Delegation[] = [
  { iss: ALICE, aud: 'role:member', cmd: '/record/write', pol: [['==', '.collection', 'app.chess']] },
  {
    iss: ALICE,
    aud: 'role:member',
    cmd: '/record/delete',
    pol: [
      ['==', '.collection', 'app.chess'],
      ['==', '.byCreator', true],
    ],
  },
  { iss: ALICE, aud: 'role:referee', cmd: '/record/delete', pol: [['==', '.collection', 'app.chess']] },
  { iss: ALICE, aud: 'role:admin', cmd: '/role/unassign', pol: [['==', '.role', 'referee']] },
  {
    iss: ALICE,
    aud: 'role:admin',
    cmd: '/role/assign',
    pol: [
      ['==', '.role', 'moderator'],
      ['==', '.self', false],
    ],
  },
  {
    iss: ALICE,
    aud: 'role:moderator',
    cmd: '/member/remove',
    pol: [
      ['==', '.self', false],
      ['not', ['any', '.roles', ['==', '.', 'admin']]],
    ],
  },
  {
    iss: ALICE,
    aud: 'role:admin',
    cmd: '/role/assign',
    pol: [
      ['==', '.role', 'referee'],
      ['==', '.self', false],
    ],
  },
];

/** On each move: the player whose turn it is made it */
export const moveContract: Check[] = [
  {
    that: "versions([body.game]).all(g, g.collection == 'app.chess.game' && author == (int(body.ply) % 2 == 0 ? g.body.white : g.body.black))",
    else: 'Players move in turn',
  },
];

// -- The story ---------------------------------------------------------------------

/** Alice founds; makes Erin admin and Bob, Carol, Dave, Frank members; Erin makes Dave referee; Bob tries Frank. */
export const assignments: Assignment[] = [
  { by: ALICE, to: ERIN, role: 'admin' },
  ...[BOB, CAROL, DAVE, FRANK].map((to) => ({ by: ALICE, to, role: 'member' })),
  { by: ERIN, to: DAVE, role: 'referee' },
  { by: BOB, to: FRANK, role: 'referee' },
];

/** Erin appoints Mo moderator. Kept apart from `assignments`, which the parked Datalog reads. */
export const moderation: Assignment[] = [{ by: ERIN, to: MO, role: 'moderator' }];

export const game = version({
  id: 'game',
  collection: 'app.chess.game',
  author: BOB,
  body: { white: BOB, black: CAROL },
});

export const moves = [
  version({ id: 'm0', collection: 'app.chess', author: BOB, body: { game: 'game', ply: 0 } }),
  version({ id: 'm1', collection: 'app.chess', author: CAROL, body: { game: 'game', ply: 1 } }),
  version({ id: 'm1-bob', collection: 'app.chess', author: BOB, body: { game: 'game', ply: 1 } }),
];
