/**
 * What an assembly keeps: ordinary collections, defined in the space when
 * the assembly is made. The assembly's grants (`assemblyRoles`) say who
 * may write what, and every device enforces them. What the records mean (how a vote travels along
 * delegations) is this app's, in `tally.ts`.
 *
 * A result only ever moves forward. Every proposal fixes who votes on it,
 * and how many of them must vote for it to pass, when it is made; votes are
 * final; and a decision is a proof that cites enough votes to settle it,
 * which no later vote can undo. So every device
 * reaches the same result from whatever votes it holds, in any order, with
 * nobody closing the vote and no clock (issue #131).
 *
 * The names are Liquid's own (`liquid.*`) rather than the standard
 * library's: `std.proposal` has fixed options and no topic, and nothing in
 * the library says "I trust this person with my vote on housing".
 */
import { rolePresets, ROLE_ASSIGN, RECORD_DELETE, RECORD_WRITE } from '@weaveprotocol/core';
import type { Check, SpaceRole } from '@weaveprotocol/core';
import { fragments } from '@weaveprotocol/core/schemas';

const { typed, words, text, markdown, count, choice, people, one } = fragments;

/** The most voters one proposal can have */
export const MAX_VOTERS = 500;

/** The most votes a decision can cite, so a proposal's rule must settle it with no more either way */
export const MAX_CITED = 255;

/** Ids of versions a record cites */
const ids = (max: number, description: string) => ({
  type: 'array',
  items: words(128),
  maxItems: max,
  description,
});

// Conditions for the checks below, in CEL, built here so they read as what
// they say. What they build is CEL text, stored with the definition.

/** The one version cited by the id at `path`, or a field of it */
const citedOne = (path: string, field: string) => `versions([${path}])[0].${field}`;
/** The one version cited by the id at `path` has that field */
const citedHas = (path: string, field: string) => `has(${citedOne(path, field)})`;
/** Half of a count, rounded down */
const half = (n: string) => `(${n} / 2)`;
/** `n` × `top` / `bottom`, rounded up */
const share = (n: string, top: number, bottom: number) => `((${n} * ${top} + ${bottom - 1}) / ${bottom})`;
/** How many different people wrote the versions cited at `path` */
const authorsOf = (path: string) => `versions(${path}).map(it, it.author).distinct().size()`;
/** Every version cited at `path` is a first version of `collection`, about what this record is about */
const allAbout = (path: string, collection: string, also: ReadonlyArray<string>) =>
  `versions(${path}).all(it, ${[
    `it.collection == "${collection}"`,
    'it.link("about") == link("about")',
    'it.seq == 0',
    ...also,
  ].join(' && ')})`;

/** What an assembly may vote on, sorted into topics. Only moderators set them. */
export const topic = typed<Topic>()({
  name: 'liquid.topic',
  title: 'Topic',
  description: 'An area proposals belong to, and delegations can be limited to.',
  schema: {
    type: 'object',
    properties: {
      name: words(60),
      description: text(300),
      hue: count(0, 359, 'Its colour, as a hue'),
    },
    required: ['name'],
  },
});
interface Topic {
  readonly name: string;
  readonly description?: string;
  readonly hue?: number;
}

/** The three answers to a proposal */
export const CHOICES = ['for', 'against', 'abstain'] as const;
export type Choice = (typeof CHOICES)[number];

/**
 * Something put to the assembly: yes or no. Who votes on it, and how many of
 * them must vote for it to pass (`toPass`), are fixed when it is made. It
 * fails once so many vote against or abstain that `toPass` can't be reached.
 */
export const proposal = typed<Proposal>()({
  name: 'liquid.proposal',
  title: 'Proposal',
  description: 'Something put to the assembly to accept or reject, and who votes on it.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      body: markdown(20000),
      voters: people(MAX_VOTERS, 'Who votes on it, picked from the members when it was proposed'),
      toPass: count(1, MAX_CITED, 'How many of its voters must vote for it to pass'),
    },
    required: ['title', 'voters', 'toPass'],
  },
  links: { topic: one(['liquid.topic'], 'The topic it belongs to') },
  rules: {
    fixed: ['voters', 'toPass'],
    check: [
      {
        that: `seq != 0 || (size(body.voters) >= 1 && size(body.voters) <= ${MAX_VOTERS} && body.voters.distinct().size() == size(body.voters) && body.voters.all(it, member(it)))`,
        else: `A proposal's voters are members, each once, from 1 to ${MAX_VOTERS} of them`,
      },
      {
        that: `body.toPass <= size(body.voters) && size(body.voters) - int(body.toPass) <= ${MAX_CITED - 1}`,
        else: `A proposal can't need more votes for than it has voters, nor more than ${MAX_CITED} votes either way`,
      },
    ],
  },
});
interface Proposal {
  readonly title: string;
  readonly body?: string;
  readonly voters: ReadonlyArray<string>;
  readonly toPass: number;
}

/** "This should be looked at": one per person per proposal, for sorting. It decides nothing. */
export const support = typed<Record<string, never>>()({
  name: 'liquid.support',
  title: 'Support',
  description: 'Someone wants a proposal to be seen.',
  schema: { type: 'object', properties: {} },
  links: { about: one(['liquid.proposal'], 'The proposal') },
  rules: { onePer: ['@author', 'link:about'] },
});

/**
 * Someone's vote on a proposal: one per person per proposal, and final. A
 * vote their device cast by following someone they trust says whom
 * (`via`), so the path a vote took is on the record.
 */
export const vote = typed<Vote>()({
  name: 'liquid.vote',
  title: 'Vote',
  description:
    'A final vote on a proposal, cast by its voter or by their device following someone they trust.',
  schema: {
    type: 'object',
    properties: {
      choice: choice(CHOICES),
      via: text(
        256,
        'Whom it follows: an account DID, or a party’s key. Absent when they voted themselves.',
        1,
      ),
    },
    required: ['choice'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal') },
  rules: { onePer: ['@author', 'link:about'], final: true },
});
interface Vote {
  readonly choice: Choice;
  readonly via?: string;
}

/** Everything, for a delegation that isn't limited to one topic */
export const EVERYTHING = '*';

/**
 * "When I don't vote on this topic, vote as they do." One per person per
 * topic (or `*`, for everything else): delegating again moves it, deleting
 * it takes it back. The voter's own device reads it, and casts their vote
 * once the person or party they trust has voted.
 */
export const delegation = typed<Delegation>()({
  name: 'liquid.delegation',
  title: 'Delegation',
  description: 'Who someone’s device follows when they don’t vote, on one topic or on everything.',
  schema: {
    type: 'object',
    properties: {
      kind: choice(['person', 'party']),
      to: text(256, 'An account DID, or a party’s key', 1),
      topic: text(128, 'A topic’s key, or * for everything', 1),
    },
    required: ['kind', 'to', 'topic'],
  },
  history: 'all',
  rules: { onePer: ['@author', 'topic'] },
});
interface Delegation {
  readonly kind: 'person' | 'party';
  readonly to: string;
  readonly topic: string;
}

/** How many votes for the proposal a decision cites needs: its `toPass` */
const toPassOf = (path: string) => `int(${citedOne(path, 'body.toPass')})`;

/**
 * Settles a proposal: it cites the proposal (any version: its voters and
 * `toPass` never change), and enough final votes from its voters that
 * nothing later can change the outcome. Passed: `toPass` of them voted for.
 * Rejected: so many voted against or abstained that `toPass` can no longer
 * be reached. Anyone may write it, once per proposal, and every device
 * checks it.
 */
export const decision = typed<Decision>()({
  name: 'liquid.decision',
  title: 'Decision',
  description: 'What a proposal came to, proven by the votes it cites.',
  schema: {
    type: 'object',
    properties: {
      outcome: choice(['passed', 'rejected']),
      proposal: words(128, 'The id of a version of the proposal'),
      voters: people(MAX_VOTERS, 'The proposal’s voters, as it lists them'),
      votes: ids(255, 'Ids of the votes it counts'),
    },
    required: ['outcome', 'proposal', 'voters', 'votes'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal decided') },
  rules: {
    onePer: ['link:about'],
    final: true,
    check: [
      {
        that: [
          `${citedOne('body.proposal', 'collection')} == "liquid.proposal"`,
          `${citedOne('body.proposal', 'key')} == link("about")`,
          `${citedOne('body.proposal', 'body.voters')} == body.voters`,
        ].join(' && '),
        else: 'A decision cites the proposal it decides, and its voters',
      },
      {
        that: allAbout('body.votes', 'liquid.vote', [
          'it.author in body.voters',
          '(body.outcome == "passed" ? it.body.choice == "for" : it.body.choice != "for")',
        ]),
        else: 'A decision counts only votes on its proposal, by its voters, for its outcome',
      },
      {
        that: `(body.outcome == "passed" ? ${authorsOf('body.votes')} >= ${toPassOf('body.proposal')} : ${authorsOf('body.votes')} + ${toPassOf('body.proposal')} > size(body.voters))`,
        else: 'A proposal passes once as many voters as it needs voted for, and fails once that can’t happen',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Decision {
  readonly outcome: 'passed' | 'rejected';
  readonly proposal: string;
  readonly voters: ReadonlyArray<string>;
  readonly votes: ReadonlyArray<string>;
}

/** The two versions a conflict cites differ in `field` of their bodies, one of them lacking it counts */
const differs = (field: string) => {
  const [a, b] = ['0', '1'].map((i) => `versions(body.versions)[${i}].body.${field}`);
  return `(has(${a}) ? (!has(${b}) || ${a} != ${b}) : has(${b}))`;
};

/**
 * Proof that one record was written twice, two ways: two first versions of
 * the same vote with different choices, or of the same party roll with
 * different members. Honest devices never do this, so whoever finds it
 * writes this, and every device shows the proposal it is about as disputed.
 */
export const conflict = typed<Conflict>()({
  name: 'liquid.conflict',
  title: 'Conflict',
  description: 'Two different first versions of one vote or party roll: proof that someone said two things.',
  schema: {
    type: 'object',
    properties: {
      record: words(128, 'The key of the record written twice'),
      versions: ids(2, 'The two versions'),
    },
    required: ['record', 'versions'],
  },
  links: { about: one(['liquid.proposal'], 'The proposal it disputes') },
  rules: {
    onePer: ['record'],
    final: true,
    check: [
      {
        that: [
          'size(body.versions) == 2',
          'versions(body.versions).all(it, it.collection in ["liquid.vote", "liquid.party-roll"] && it.key == body.record && it.seq == 0 && it.link("about") == link("about"))',
          `(${differs('choice')} || ${differs('members')})`,
        ].join(' && '),
        else: 'A conflict cites two first versions of one vote or party roll that say different things',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Conflict {
  readonly record: string;
  readonly versions: ReadonlyArray<string>;
}

/**
 * How a party takes a position: once this share of its members vote the
 * same way themselves, or as its representative votes. Every share is more
 * than half, so a party can never reach two positions at once.
 */
export const PARTY_RULES = [
  'majority',
  'two-thirds',
  'three-quarters',
  'everyone',
  'representative',
] as const;
export type PartyRule = (typeof PARTY_RULES)[number];

/** The cited party decides this way */
const decidesIs = (rule: string) => `${citedOne('body.party', 'body.decides')} == "${rule}"`;

/** How many of `n` members (a count) a party's rule needs, as a condition */
const sharePerRule = (n: string) => {
  const rule = citedOne('body.party', 'body.decides');
  return `(${rule} == "two-thirds" ? ${share(n, 2, 3)} : ${rule} == "three-quarters" ? ${share(n, 3, 4)} : ${rule} == "everyone" ? ${n} : ${half(n)} + 1)`;
};

/**
 * A party: a name, what it stands for, who is in it, its stewards, who keep
 * it, and how it decides (`decides`). Any steward may change it, so the
 * party carries on when one stops using Liquid. Someone is in the party when
 * they are on its list and have asked to join (`membership`).
 */
export const party = typed<Party>()({
  name: 'liquid.party',
  title: 'Party',
  description: 'A group that votes together: its members agreeing, as it decides, is its vote.',
  schema: {
    type: 'object',
    properties: {
      name: words(80),
      platform: text(2000),
      hue: count(0, 359),
      members: people(MAX_VOTERS, 'Who the stewards let in'),
      stewards: people(20, 'Who keeps the party: changes it and freezes its members for each proposal'),
      decides: choice(PARTY_RULES, 'How it takes a position'),
      representative: text(256, 'Who votes for it, when it decides by representative: a member', 1),
    },
    required: ['name', 'members', 'stewards', 'decides'],
  },
  rules: {
    check: [
      {
        that: 'size(body.stewards) >= 1 && body.stewards.all(it, it in body.members) && (prev == null ? author in body.stewards : author in prev.body.stewards)',
        else: 'Only a party’s stewards change it, and it always has a steward, who is a member',
      },
      {
        that: 'body.decides == "representative" ? (has(body.representative) && body.representative in body.members) : !has(body.representative)',
        else: 'A party that decides by representative names one of its members, and only then',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface Party {
  readonly name: string;
  readonly platform?: string;
  readonly hue?: number;
  readonly members: ReadonlyArray<string>;
  readonly stewards: ReadonlyArray<string>;
  readonly decides: PartyRule;
  readonly representative?: string;
}

/** Someone asking to be in a party, or staying in it. Deleting it leaves. */
export const membership = typed<Record<string, never>>()({
  name: 'liquid.membership',
  title: 'Party membership',
  description: 'Someone wants to be in a party.',
  schema: { type: 'object', properties: {} },
  links: { about: one(['liquid.party'], 'The party') },
  rules: { onePer: ['@author', 'link:about'] },
});

/**
 * A party's members and how it decides, frozen for one proposal by one of
 * its stewards: how many of these members must vote alike (`toTake`), or
 * whose vote is the party's (`representative`). Its position on that
 * proposal follows this, whatever the party says later. One per party per
 * proposal, and final: a second, different one is a conflict.
 */
export const partyRoll = typed<PartyRoll>()({
  name: 'liquid.party-roll',
  title: 'Party roll',
  description: 'A party’s members, frozen for one proposal.',
  schema: {
    type: 'object',
    properties: {
      party: words(128, 'The id of the party’s version it was taken from'),
      members: people(MAX_VOTERS, 'Its members for this proposal'),
      toTake: count(1, MAX_VOTERS, 'How many of them must vote alike for the party to take a position'),
      representative: text(256, 'Whose own vote is the party’s, instead', 1),
    },
    required: ['party', 'members'],
  },
  links: {
    party: one(['liquid.party'], 'The party'),
    about: one(['liquid.proposal'], 'The proposal'),
  },
  rules: {
    onePer: ['link:party', 'link:about'],
    final: true,
    check: [
      {
        that: [
          `${citedOne('body.party', 'collection')} == "liquid.party"`,
          `${citedOne('body.party', 'key')} == link("party")`,
          `author in ${citedOne('body.party', 'body.stewards')}`,
          `body.members.all(it, it in ${citedOne('body.party', 'body.members')})`,
        ].join(' && '),
        else: 'A party roll is written by a steward, from the party’s own member list',
      },
      {
        that: `(${decidesIs('representative')}) ? (has(body.representative) && body.representative == ${citedOne('body.party', 'body.representative')} && body.representative in body.members && !has(body.toTake)) : (!has(body.representative) && has(body.toTake) && body.toTake == ${sharePerRule('size(body.members)')})`,
        else: 'A party roll freezes how the party decides, as the party says, and its representative is a member',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface PartyRoll {
  readonly party: string;
  readonly members: ReadonlyArray<string>;
  readonly toTake?: number;
  readonly representative?: string;
}

/** The party roll a party's position cites */
const rollItself = 'versions([body.roll])[0]';

/**
 * A party's position on a proposal: as many of its frozen members as its
 * roll says voted this way themselves, or
 * its representative did. Votes cast by following someone don't count, so a
 * party can't count its own followers back into itself. Anyone may write
 * it; followers' devices then cast the same vote.
 */
export const partyBallot = typed<PartyBallot>()({
  name: 'liquid.party-ballot',
  title: 'Party position',
  description: 'How a party voted on a proposal, proven by its members’ own votes.',
  schema: {
    type: 'object',
    properties: {
      choice: choice(CHOICES),
      roll: words(128, 'The id of the party’s roll for this proposal'),
      members: people(MAX_VOTERS, 'The roll’s members'),
      votes: ids(255, 'Ids of the members’ votes it counts'),
    },
    required: ['choice', 'roll', 'members', 'votes'],
  },
  links: {
    party: one(['liquid.party'], 'The party'),
    about: one(['liquid.proposal'], 'The proposal'),
  },
  rules: {
    onePer: ['link:party', 'link:about'],
    final: true,
    check: [
      {
        that: [
          `${citedOne('body.roll', 'collection')} == "liquid.party-roll"`,
          `${rollItself}.link("party") == link("party")`,
          `${rollItself}.link("about") == link("about")`,
          `${citedOne('body.roll', 'body.members')} == body.members`,
        ].join(' && '),
        else: 'A party’s position cites its roll for the proposal',
      },
      {
        that: allAbout('body.votes', 'liquid.vote', [
          'it.author in body.members',
          'it.body.choice == body.choice',
          '!has(it.body.via)',
        ]),
        else: 'A party’s position counts only its members’ own votes, for that choice',
      },
      {
        that: `!${citedHas('body.roll', 'body.representative')} ? ${authorsOf('body.votes')} >= ${citedOne('body.roll', 'body.toTake')} : (${authorsOf('body.votes')} >= 1 && versions(body.votes).all(it, it.author == ${citedOne('body.roll', 'body.representative')}))`,
        else: 'A party takes a position once as many members as its roll needs voted that way, or its representative did',
      },
    ] satisfies ReadonlyArray<Check>,
  },
});
interface PartyBallot {
  readonly choice: Choice;
  readonly roll: string;
  readonly members: ReadonlyArray<string>;
  readonly votes: ReadonlyArray<string>;
}

/** Everything an assembly needs, defined when one is made */
/**
 * An assembly's founding roles: a community's admins and moderators, and
 * members who write their own records but topics, may change any party (its
 * check lets only its stewards), and delete only their own, never a proposal
 * or a topic. Moderators change and remove anything. With `membersInvite`,
 * members invite members too.
 */
export function assemblyRoles(membersInvite = false): ReadonlyArray<SpaceRole> {
  const notIn = (...collections: string[]) =>
    collections.map((collection) => ['!=', '.collection', collection] as const);
  const member: SpaceRole = {
    name: 'member',
    title: 'Member',
    grants: [
      {
        cmd: RECORD_WRITE,
        pol: [
          ...notIn(topic.name),
          [
            'or',
            [
              ['==', '.byCreator', true],
              ['==', '.collection', party.name],
            ],
          ],
        ],
      },
      { cmd: RECORD_DELETE, pol: [...notIn(topic.name, proposal.name), ['==', '.byCreator', true]] },
      ...(membersInvite ? [{ cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] }] : []),
    ],
  };
  return rolePresets.community.roles.map((role) => (role.name === 'member' ? member : role));
}

export const ASSEMBLY = [
  topic,
  proposal,
  support,
  vote,
  delegation,
  decision,
  conflict,
  party,
  membership,
  partyRoll,
  partyBallot,
] as const;
