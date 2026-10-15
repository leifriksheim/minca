/**
 * The developers page's walkthrough: one setup, then the same steps in the
 * terms of each community in `scenarios/communities/`. Every snippet is the
 * real library API; each tab's steps run in order as one program.
 */
import { rolePresets, STAFF_COLLECTIONS, type RolePreset, type Statement } from '@minca/core';
import type { ShapeKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';

/** The constitution templates a step can spread */
type PresetName = keyof typeof rolePresets;

export interface WalkStep {
  /** Which of the five steps: start, data, rules, use, proof */
  readonly label: string;
  readonly text: string;
  readonly file: string;
  readonly code: string;
  /** The preset its code spreads, written out under it */
  readonly preset?: PresetName;
}

export interface Scenario {
  /** Its URL hash: `#coop` */
  readonly id: string;
  readonly name: string;
  /** Its tab's mark */
  readonly shape: { readonly kind: ShapeKind; readonly colour: ShapeColour };
  readonly summary: string;
  /** The scenario that runs these steps as a test, in `scenarios/communities/` */
  readonly test: string;
  readonly steps: ReadonlyArray<WalkStep>;
}

export const CONNECT = `
import * as z from 'zod'; // or Valibot, ArkType, plain JSON Schema
import {
  createNode, createIdentityManager, createLocalRootSigner,
  indexedDBStores, rolePresets, collection, lineKey,
} from '@minca/core';

const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(password);
const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()),
  stores: indexedDBStores('my-app'), // or a folder: folderStores(dir)
  network: { relays: ['wss://p2p-web-relay.fly.dev'] },
});
`;

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: 'team',
    name: 'Team workspace',
    shape: { kind: 'briefcase', colour: 'cobalt' },
    summary:
      'A company team. You and a cofounder at the top for good, editors who can change anything, and corners of its own, like HR.',
    test: 'company.ts',
    steps: [
      {
        label: 'Start the space',
        text: 'The first record in a space is its founding rules. Here: you and Sam at the top, for good, and the team preset’s roles below you.',
        file: 'space.ts',
        code: `
const space = await node.spaces.create({
  name: 'Acme', visibility: 'private',
  ...rolePresets.team, // founders on top, editors below
  cofounders: [samDid], // founded with Sam
});
`,
        preset: 'team',
      },
      {
        label: 'Describe the data',
        text: 'A collection is a kind of record and its schema. The definition lives in the space, so any app or agent that opens it knows what it holds.',
        file: 'tasks.ts',
        code: `
const tasks = collection({
  name: 'app.task',
  schema: z.object({ title: z.string(), done: z.boolean() }),
});
await node.collections.define(space.id, tasks);
`,
      },
      {
        label: 'Say who may do what',
        text: 'Editors can change any record and invite more editors. A team of your own is just a role: HR writes in app.hr, and nowhere else.',
        file: 'roles.ts',
        code: `
await node.spaces.defineRole(space.id, {
  name: 'hr', title: 'HR',
  grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.hr']] }],
});
await node.spaces.assign(space.id, halDid, 'hr');
`,
      },
      {
        label: 'Use it',
        text: 'Invite a colleague and start writing. Each record is signed, saved on the device first, then synced to everyone in the space.',
        file: 'use.ts',
        code: `
// A colleague calls node.spaces.join(invite)
const invite = await node.spaces.invite(space.id, { role: 'editor' });

await node.records.put(space.id, tasks, { title: 'Ship v1', done: false });
`,
      },
      {
        label: 'What it shows',
        text: 'Queries are plain JSON, typed from the schema. Swap query for watch and it reruns whenever a change arrives.',
        file: 'open.ts',
        code: `
const { records } = await node.records.query(space.id, {
  collection: tasks,
  where: { done: false },
  sort: { '@createdAt': 'desc' },
});
`,
      },
    ],
  },
  {
    id: 'club',
    name: 'Club',
    shape: { kind: 'pawn', colour: 'coral' },
    summary:
      'A chess club. Admins and moderators run it, members play, and the club makes up a referee of its own.',
    test: 'chess.ts',
    steps: [
      {
        label: 'Start the space',
        text: 'The community preset: you found it, admins run it, moderators keep order, and members change only what they made.',
        file: 'space.ts',
        code: `
const space = await node.spaces.create({
  name: 'Chess club', visibility: 'private',
  ...rolePresets.community, // admin, moderator, member
});
`,
        preset: 'community',
      },
      {
        label: 'Describe the data',
        text: 'Games, and moves that link to their game. Links are declared, so every app knows what points at what.',
        file: 'chess.ts',
        code: `
const games = collection({
  name: 'app.chess.game',
  schema: z.object({ white: z.string(), black: z.string() }),
});
const moves = collection({
  name: 'app.chess.move',
  schema: z.object({ san: z.string(), ply: z.int().min(0) }),
  links: { game: { to: ['app.chess.game'], cardinality: 'one' } },
});
await node.collections.define(space.id, games);
await node.collections.define(space.id, moves);
`,
      },
      {
        label: 'Say who may do what',
        text: 'There are no built-in ranks. A referee is a role the club invents: it can delete any move, where members delete only their own.',
        file: 'referee.ts',
        code: `
await node.spaces.defineRole(space.id, {
  name: 'referee', title: 'Referee',
  grants: [
    { cmd: '/record/delete', pol: [['==', '.collection', 'app.chess.move']] },
  ],
});
await node.spaces.assign(space.id, daveDid, 'referee');
`,
      },
      {
        label: 'Use it',
        text: 'An invite link makes a member. Members start games and move, and every device checks each move against the roles as it arrives.',
        file: 'play.ts',
        code: `
const invite = await node.spaces.invite(space.id, { role: 'member' });

const game = await node.records.put(space.id, games,
  { white: bobDid, black: carolDid });
const move = await node.records.put(space.id, moves, { san: 'e4', ply: 0 },
  { links: [{ rel: 'game', to: game.key }] });
`,
      },
      {
        label: 'What it shows',
        text: 'The game so far, in order. Ask whether you may delete a move, and hide the button instead of showing an error.',
        file: 'board.ts',
        code: `
const { records } = await node.records.query(space.id, {
  collection: moves,
  where: { 'link:game': game.key },
  sort: { ply: 'asc' },
});
const mayDelete = await node.records.can(space.id, 'delete', move.key);
`,
      },
    ],
  },
  {
    id: 'coop',
    name: 'Co-op',
    shape: { kind: 'group', colour: 'sage' },
    summary: 'A bike co-op with no one at the top. Stewards run it, and any one of them can be removed.',
    test: 'coop.ts',
    steps: [
      {
        label: 'Start the space',
        text: 'With top: none there are no founders. You start as a steward, and that is all the power you get.',
        file: 'space.ts',
        code: `
const space = await node.spaces.create({
  name: 'Bike co-op', visibility: 'private',
  ...rolePresets.coop, // top: 'none', you start as a steward
});
space.founders; // []: nobody is permanent
`,
        preset: 'coop',
      },
      {
        label: 'Describe the data',
        text: 'What the co-op keeps track of: bikes in for repair.',
        file: 'repairs.ts',
        code: `
const repairs = collection({
  name: 'app.repair',
  schema: z.object({ bike: z.string(), fixed: z.boolean() }),
});
await node.collections.define(space.id, repairs);
`,
      },
      {
        label: 'Say who may do what',
        text: 'Stewards manage members and each other. Nobody can redefine steward: new founding rules take a successor space.',
        file: 'stewards.ts',
        code: `
await node.spaces.assign(space.id, beaDid, 'steward');

// Any steward may remove anyone, you included. Two who remove
// each other while offline both stand removed
await node.spaces.removeMember(space.id, beaDid);
`,
      },
      {
        label: 'Use it',
        text: 'Members write and change their own records, and can name a successor space when the co-op wants new founding rules.',
        file: 'use.ts',
        code: `
const invite = await node.spaces.invite(space.id, { role: 'member' });

await node.records.put(space.id, repairs, { bike: 'Blue cargo', fixed: false });
`,
      },
    ],
  },
  {
    id: 'fame',
    name: 'Hall of fame',
    shape: { kind: 'star', colour: 'peach' },
    summary:
      'A comment makes the hall of fame once five different people react 🙂, and every device agrees it did.',
    test: 'fame.ts',
    steps: [
      {
        label: 'Describe the data',
        text: 'Comments, and reactions that point at one. The space starts as in the club.',
        file: 'comments.ts',
        code: `
const Reaction = z.object({ emoji: z.string() });
const onComment = { on: { to: ['app.comment'], cardinality: 'one' } } as const;

const comments = collection({ name: 'app.comment', schema: z.object({ text: z.string() }) });
const reactions = collection({
  name: 'app.reaction', schema: Reaction, links: onComment,
  history: 'all', // every version kept whole, so a claim can cite it
});
`,
      },
      {
        label: 'Say what counts',
        text: 'A claim of fame cites the reactions, and its contract says what they must prove. It is typed from the schemas, so a wrong field is a compile error.',
        file: 'fame.ts',
        code: `
const Fame = z.object({ reactions: z.array(z.string()) });
const fame = collection({
  name: 'app.fame', schema: Fame, links: onComment,
  contract: {
    check: ({ body, cited, link }) => ({
      'Needs five different people': cited(body.reactions, reactions)
        .where((r) => r.link('on').eq(link('on')).and(r.body.emoji.eq('🙂')))
        .map((r) => r.author).distinct().count().gte(5),
    }),
  },
});
for (const c of [comments, reactions, fame]) await node.collections.define(space.id, c);
`,
      },
      {
        label: 'Use it',
        text: 'Someone comments, and members react, each from their own device.',
        file: 'react.ts',
        code: `
const post = await node.records.put(space.id, comments, { text: 'gg' });
const on = [{ rel: 'on', to: post.key }];

await node.records.put(space.id, reactions, { emoji: '🙂' }, { links: on });
`,
      },
      {
        label: 'What it proves',
        text: 'Whoever sees the fifth writes the claim, citing all five. Every device runs the same contract and reaches the same verdict. No server, no blockchain.',
        file: 'claim.ts',
        code: `
const smiles = await node.records.linked(space.id, post.key,
  { rel: 'on', collection: 'app.reaction' });
const claim = await node.records.put(space.id, fame,
  { reactions: smiles.map((r) => r.version) }, { links: on });

await node.records.contracts(space.id, claim.key);
// { passes: true }. Four, or one person twice: no device counts it
`,
      },
    ],
  },
  {
    id: 'credit',
    name: 'Mutual credit',
    shape: { kind: 'coin', colour: 'lilac' },
    summary:
      'Members pay each other in a currency of their own. Nobody goes below −100, and nobody spends twice.',
    test: 'credit.ts',
    steps: [
      {
        label: 'Describe the data',
        text: 'A payment carries the payer’s running balance, and claims the payments made to them. The space starts as in the club.',
        file: 'payment.ts',
        code: `
const Payment = z.object({
  to: z.string(),
  amount: z.number(),
  balance: z.number(), // after this payment
  received: z.array(z.string()), // payments to you, by version id
});
`,
      },
      {
        label: 'Say what counts',
        text: 'Each account’s payments form one line, each after the last. Two payments after the same one are a double spend, and neither counts.',
        file: 'pay.ts',
        code: `
const pay = collection({
  name: 'app.pay', schema: Payment,
  contract: {
    line: { once: ['received'] }, // a payment is claimed once
    check: ({ body, prev, versions, when }) => ({
      'The balance follows from the one before': body.balance.eq(
        when(prev.eq(null), 0, prev.body.balance).sub(body.amount)
          .add(versions(body.received).of(Payment).map((r) => r.body.amount).sum())),
      'No one goes below −100': body.balance.gte(-100),
    }), // and more: see scenarios/communities/credit.ts
  },
});
`,
      },
      {
        label: 'Use it',
        text: 'Your payments are versions of one record, your line, at a key only your account can write.',
        file: 'send.ts',
        code: `
await node.collections.define(space.id, pay);

// Your line is at a key in your namespace: only you can write it
const line = await lineKey(node.did, 'app.pay');
const first = await node.records.put(space.id, pay,
  { to: bobDid, amount: 30, balance: -30, received: [] },
  { key: line });

// Each payment after is the line's next version
await node.records.update(space.id, first.key,
  { to: carolDid, amount: 50, balance: -80, received: [] });
`,
      },
      {
        label: 'What it shows',
        text: 'A balance is the newest payment on someone’s line that counts, and every device works it out the same way.',
        file: 'balance.ts',
        code: `
const head = await node.records.get<{ balance: number }>(space.id,
  await lineKey(bobDid, 'app.pay'));
head?.body?.balance; // what Bob has, as every device sees it
`,
      },
    ],
  },
];

// ─── A preset, written out ──────────────────────────────────────────

/** Commands that hold under the same conditions */
interface GrantLine {
  /** The conditions, in words: "always" when there are none */
  readonly when: string;
  readonly cmds: ReadonlyArray<string>;
}

interface PresetRole {
  readonly name: string;
  readonly lines: ReadonlyArray<GrantLine>;
}

interface PresetSummary {
  readonly name: PresetName;
  /** Who is at the top, in a sentence */
  readonly top: string;
  readonly roles: ReadonlyArray<PresetRole>;
  /** Whether a condition names the staff collections, which the summary then lists */
  readonly staff: boolean;
}

const isList = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

/** The values a list of statements compares `field` to, when each is `['==', field, value]` */
function equalsAll(list: unknown, field: string): ReadonlyArray<string> | null {
  if (!isList(list)) return null;
  const values: string[] = [];
  for (const statement of list) {
    if (!isList(statement) || statement[0] !== '==' || statement[1] !== field) return null;
    if (typeof statement[2] !== 'string') return null;
    values.push(statement[2]);
  }
  return values;
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** One policy statement, in words, for the shapes the presets use; anything else as it is written */
function inWords(statement: Statement): string {
  const [op, a, b] = statement;
  if (op === '==' && a === '.byCreator' && b === true) return 'own records';
  if (op === '==' && a === '.role' && typeof b === 'string') return `the ${b} role`;
  if (op === '!=' && a === '.role' && typeof b === 'string') return `any role but ${b}`;
  const roles = op === 'or' ? equalsAll(a, '.role') : null;
  if (roles) return `the ${roles.join(' or ')} role`;
  if (op === 'not' && isList(a)) {
    const held = a[0] === 'any' && a[1] === '.roles' ? equalsAll([a[2]], '.') : null;
    if (held) return `whoever isn't ${held.join(', ')}`;
    const collections = a[0] === 'or' ? equalsAll(a[1], '.collection') : null;
    if (collections)
      return sameSet(collections, STAFF_COLLECTIONS)
        ? 'outside the staff collections'
        : `outside ${collections.join(', ')}`;
  }
  return JSON.stringify(statement);
}

/** What a preset holds: who is at the top, and each role's commands grouped by their conditions */
export function describePreset(name: PresetName): PresetSummary {
  const preset: RolePreset = rolePresets[name];
  const roles = preset.roles.map((role) => {
    const lines: Array<{ when: string; cmds: string[] }> = [];
    for (const grant of role.grants) {
      const when = grant.pol.length ? grant.pol.map(inWords).join(', ') : 'always';
      const line = lines.find((l) => l.when === when);
      if (line) line.cmds.push(grant.cmd);
      else lines.push({ when, cmds: [grant.cmd] });
    }
    return { name: role.name, lines };
  });
  const top =
    preset.top === 'founders'
      ? 'You, and any cofounders, are its founders: you hold every command, and no one else can remove you.'
      : `No founders: you start as ${(preset.creatorRoles ?? []).join(', ')}, and that is all.`;
  return {
    name,
    top,
    roles,
    staff: roles.some((role) => role.lines.some((line) => line.when.includes('staff'))),
  };
}
