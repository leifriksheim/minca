/**
 * 2. Co-op. No fixed top. Members add members; removing a member needs
 * ballots from more than half of the members, counted as of the proposal.
 */
import type { Contract } from '../../packages/core/src/records/contracts.js';
import type { Delegation } from '../host/library.js';
import type { Host } from '../host/cel-host.js';
import { version } from '../host/space.js';

// -- The community: UCAN grants, CEL contracts --------------------------------------

/** `top: "none"`: no founder, so the constitution itself grants and assigns (03 §2.1) */
export const CONSTITUTION = 'space:coop';

/** Members add members */
export const grants: Delegation[] = [
  {
    iss: CONSTITUTION,
    aud: 'role:member',
    cmd: '/role/assign',
    pol: [
      ['==', '.role', 'member'],
      ['==', '.self', false],
    ],
  },
];

/**
 * The proposal lists the members as of itself, and the check confirms the
 * list is complete: `memberCount` is a name the subset doesn't have today,
 * the number of members as of the version's `seen`. The plan replaces the
 * list with a count from the history as of the proposal (`memberCountAt`);
 * this stays until the scenarios run on the library.
 */
const proposalContract: Contract[] = [
  {
    that: 'body.members.size() == memberCount && body.members.all(m, member(m)) && body.members.distinct().size() == body.members.size() && body.member in body.members',
    else: 'A proposal lists every member as of itself',
  },
];

/** On `std.member`: an add needs nothing more; a removal cites its proposal and the ballots */
const memberContract: Contract[] = [
  {
    that: "body.op == 'add' || versions([body.proposal]).all(p, p.collection == 'coop.proposal' && p.body.member == body.did)",
    else: 'A removal cites a proposal to remove that member',
  },
  {
    that: "body.op == 'add' || versions([body.proposal]).all(p, versions(body.ballots).filter(b, b.collection == 'coop.ballot' && b.link('on') == p.key && b.body.yes == true && b.author in p.body.members).map(b, b.author).distinct().size() * 2 > p.body.members.size())",
    else: 'More than half of the members as of the proposal said yes',
  },
];

// -- The story ---------------------------------------------------------------------

export const A = 'did:key:a';
export const B = 'did:key:b';
export const C = 'did:key:c';
export const D = 'did:key:d';
export const E = 'did:key:e';
export const F = 'did:key:f';
export const FOUNDING = [A, B, C, D];

const add = (id: string, by: string, who: string, seen: string[] = []) =>
  version({ id, collection: 'std.member', author: by, body: { op: 'add', did: who }, seen });

export const ballot = (id: string, by: string, yes: boolean, seen = ['p1']) =>
  version({
    id,
    collection: 'coop.ballot',
    author: by,
    body: { yes },
    links: [{ rel: 'on', to: 'p1' }],
    seen,
  });

// A adds E. B proposes removing D, as of five members. A adds F after. Ballots. B removes D.
export const a1 = add('a1', A, E);
export const p1 = version({
  id: 'p1',
  collection: 'coop.proposal',
  author: B,
  body: { member: D, members: [A, B, C, D, E] },
  seen: ['a1'],
});
export const a2 = add('a2', A, F, ['p1']);
export const ballots = [
  ballot('bA', A, true),
  ballot('bB', B, true),
  ballot('bC', C, true),
  ballot('bD', D, false),
];
const bF = ballot('bF', F, true, ['p1', 'a2']);
export const removal = (id: string, cites: string[], proposal = 'p1') =>
  version({
    id,
    collection: 'std.member',
    author: B,
    body: { op: 'remove', did: D, proposal, ballots: cites },
    seen: [...cites, proposal, 'a2'],
  });
export const everything = [a1, p1, a2, ...ballots, bF];

export const host: Host = {
  founders: [],
  members: FOUNDING,
  contracts: { 'coop.proposal': proposalContract, 'std.member': memberContract },
  values: (_, members) => ({ memberCount: members.size }),
};
