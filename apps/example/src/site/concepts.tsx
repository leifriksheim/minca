/**
 * The developers page's concepts, top to bottom: a few sentences each, a
 * line of code, and a small drawing in HTML and CSS.
 */
import type { ReactNode } from 'react';

export interface Concept {
  /** Its tab's id */
  readonly id: string;
  readonly name: string;
  /** Its tab's icon: a path on a 16 × 16 grid, drawn like the site's other icons */
  readonly icon: string;
  readonly intro: ReactNode;
  readonly code?: string;
  readonly visual: ReactNode;
}

/** A box in a drawing: a name, and a line under it */
function Box({
  name,
  sub,
  ink,
  children,
}: {
  name: string;
  sub?: string;
  ink?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={ink ? 'viz-box ink' : 'viz-box'}>
      <b>{name}</b>
      {sub && <small>{sub}</small>}
      {children}
    </div>
  );
}

/** An arrow: across on wide screens, down on narrow ones */
function Arrow({ label }: { label?: string }) {
  return (
    <span className="viz-arrow">
      <span aria-hidden>→</span>
      {label && <small>{label}</small>}
    </span>
  );
}

const LOCK = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden
  >
    <path d="M4 7.5h8v6.5H4z M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" strokeLinejoin="round" />
  </svg>
);

const IDENTITY = (
  <div className="viz" role="img" aria-label="One account signs a note for each device and app key">
    <Box ink name="Your account" sub="a recovery code or a passkey" />
    <span className="viz-arrow down">
      <span aria-hidden>→</span>
      <small>signs a note for each key</small>
    </span>
    <div className="viz-row">
      <Box name="Laptop" sub="its own key">
        <span className="viz-note">may do all I may</span>
      </Box>
      <Box name="Phone" sub="its own key">
        <span className="viz-note">may do all I may</span>
      </Box>
      <Box name="Poll app" sub="its own key">
        <span className="viz-note">the Club space, for 30 days</span>
      </Box>
    </div>
  </div>
);

const APPS = (
  <div
    className="viz"
    role="img"
    aria-label="An app asks your account home for access; the home hands the app a pass for exactly what you approved"
  >
    <div className="viz-exchange">
      <Box name="Poll app" sub="no keys" />
      <div className="viz-exchange-mid">
        <span className="viz-exchange-arrow">
          <small>asks</small>
          <span aria-hidden>→</span>
        </span>
        <span className="viz-exchange-arrow back">
          <span aria-hidden>←</span>
          <span className="viz-pass">
            <b>pass</b>
            Club · write · 7 days
          </span>
        </span>
      </div>
      <Box ink name="Your account home" sub="you approve" />
    </div>
    <div className="viz-caption">every device checks the pass · you can revoke it anytime</div>
  </div>
);

const SPACES = (
  <div className="viz" role="img" aria-label="A space: its constitution, and its members' devices in sync">
    <div className="viz-space">
      <div className="viz-caption">space · Bike co-op</div>
      <Box ink name="Constitution" sub="its founding rules" />
      <div className="viz-row">
        <Box name="Ann" sub="steward" />
        <Box name="Bea" sub="member" />
        <Box name="Cy" sub="member" />
      </div>
    </div>
    <div className="viz-caption">⇄ synced between the members’ devices</div>
  </div>
);

const CONSTITUTION = (
  <div
    className="viz"
    role="img"
    aria-label="A constitution, sealed by its hash, and a successor members may follow"
  >
    <div className="viz-flow">
      <Box ink name="Constitution">
        <small>top: founders · Alice</small>
        <small>roles: admin, member</small>
        <small>conflicts: strong-remove/1</small>
        <span className="viz-note">{LOCK} its id is its hash</span>
      </Box>
      <Arrow label="members start" />
      <Box name="Successor" sub="new founding rules">
        <span className="viz-note">each member chooses</span>
      </Box>
    </div>
  </div>
);

const RECORDS = (
  <div className="viz" role="img" aria-label="A record: three signed versions, one after another">
    <div className="viz-caption">
      app.task · key <code>iz75dwgy….k3t9</code> (Ann’s)
    </div>
    <div className="viz-flow">
      <Box name="v0" sub="Ship v1 · open">
        <span className="viz-note">signed: laptop</span>
      </Box>
      <Arrow />
      <Box name="v1" sub="Ship v1.0 · open">
        <span className="viz-note">signed: laptop</span>
      </Box>
      <Arrow />
      <Box ink name="v2" sub="Ship v1.0 · done">
        <span className="viz-note">signed: phone</span>
      </Box>
    </div>
  </div>
);

const ROLES = (
  <div className="viz" role="img" aria-label="People hold roles, and roles hold grants">
    <div className="viz-flow">
      <Box name="Bea, Cy" sub="people" />
      <Arrow />
      <Box ink name="editor" sub="role" />
      <Arrow />
      <Box name="/record" sub="in any collection" />
    </div>
    <div className="viz-flow">
      <Box name="Hal" sub="person" />
      <Arrow />
      <Box ink name="hr" sub="role" />
      <Arrow />
      <Box name="/record" sub="in app.hr only" />
    </div>
    <div className="viz-caption">every device checks every change against them</div>
  </div>
);

const CONTRACTS = (
  <div className="viz" role="img" aria-label="A claim cites its proof, and every device checks it">
    <div className="viz-flow">
      <Box ink name="Claim: in the hall of fame" sub="cites 5 reactions">
        <span className="viz-cites">
          {['Ann', 'Bea', 'Cy', 'Dee', 'Eve'].map((who) => (
            <span key={who}>🙂 {who}</span>
          ))}
        </span>
      </Box>
      <Arrow label="checked" />
      <div className="viz-col">
        <Box name="✓ Laptop" sub="passes" />
        <Box name="✓ Phone" sub="passes" />
        <Box name="✓ Agent" sub="passes" />
      </div>
    </div>
    <div className="viz-caption">
      a claim with four reactions, or one person twice: it syncs, and counts for no one
    </div>
  </div>
);

const SYNC = (
  <div className="viz" role="img" aria-label="Devices sync directly and encrypted; a relay introduces them">
    <div className="viz-flow">
      <Box ink name="Ann’s laptop" />
      <span className="viz-arrow">
        <span aria-hidden>⇄</span>
        <small className="viz-lock">{LOCK} end to end</small>
      </span>
      <Box ink name="Bea’s phone" />
    </div>
    <div className="viz-row">
      <Box name="Relay" sub="introduces them, then steps aside" />
      <Box name="Always-on node" sub="keeps it online, can’t read it" />
    </div>
  </div>
);

export const CONCEPTS: ReadonlyArray<Concept> = [
  {
    id: 'identity',
    name: 'Identity',
    icon: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5',
    intro:
      'A person has one account: a recovery code they keep, or a passkey. Each device and app gets a key of its own, with a note from the account saying what that key may do. There is no user table for you to keep.',
    code: 'const me = await manager.fromRecoveryCode(password);',
    visual: IDENTITY,
  },
  {
    id: 'apps',
    name: 'Apps',
    icon: 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z',
    intro:
      'An app doesn’t get your account. It asks your account home for access, and you see what it wants: which spaces, read or write, for how long. Approve, and it gets a pass that says exactly that, which every device checks and you can take back anytime. It never sees your keys or password.',
    code: "const connection = createWeaveConnection({\n  home: 'https://weave-home.netlify.app/connect',\n  request: { name: 'Polls', access: 'write',\n    scope: 'spaces' },\n});",
    visual: APPS,
  },
  {
    id: 'spaces',
    name: 'Spaces',
    icon: 'M2.5 2.5h11v11h-11zM5 6h6M5 9.5h3',
    intro:
      'A space is a group’s shared data: its members, their roles and their records, kept on each member’s devices and synced between them.',
    code: "const space = await node.spaces.create(\n  { name: 'Club', visibility: 'private' });",
    visual: SPACES,
  },
  {
    id: 'constitution',
    name: 'Constitution',
    icon: 'M2 6l6-3.5L14 6zM3.5 6.5V12M6.5 6.5V12M9.5 6.5V12M12.5 6.5V12M2 13.5h12',
    intro:
      'Every space starts from its constitution, its founding rules: who’s at the top (founders, who can’t be pushed out but may step down, or no one, like a co-op), the roles it begins with, and how conflicts resolve. Its id is its hash, so it can never be swapped. To change the founding rules, members start a successor space, and each chooses whether to follow.',
    code: "const space = await node.spaces.create({\n  name: 'Bike co-op',\n  visibility: 'private',\n  ...rolePresets.coop, // top: 'none'\n});",
    visual: CONSTITUTION,
  },
  {
    id: 'records',
    name: 'Records',
    icon: 'M4 1.5h5.5l3 3v10h-8.5zM9.5 1.5v3h3',
    intro:
      'Data is typed records in collections, whose schemas live in the space. A record is a chain of signed versions, and its key says whose it is.',
    code: "const Task = z.object({\n  title: z.string(), done: z.boolean() });\n\nconst tasks = collection({\n  name: 'app.task', schema: Task,\n  // links and rules are optional\n});\nawait node.collections.define(\n  space.id, tasks);\nawait node.records.put(space.id, tasks,\n  { title: 'Ship v1', done: false });",
    visual: RECORDS,
  },
  {
    id: 'roles',
    name: 'Roles & grants',
    icon: 'M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z',
    intro:
      'The group decides who may do what. Roles hold grants, and people hold roles. Every device checks each change against them, and refuses what breaks them.',
    code: "await node.spaces.assign(space.id, halDid, 'hr');",
    visual: ROLES,
  },
  {
    id: 'contracts',
    name: 'Contracts',
    icon: 'M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM5.5 8l2 2 3.5-4',
    intro: (
      <>
        <p>
          A contract is a rule stored with a collection: “a comment is in the hall of fame once five different
          people react 🙂”. When someone adds the fifth 🙂, their app writes a claim along with it, citing the
          five (or an always-on bot does), and every device checks the proof the same way. A claim that
          doesn’t add up syncs, but counts for no one: smart contracts without a blockchain.
        </p>
        <p>Just showing it? A live query is enough. A claim makes it a fact that others can build on.</p>
      </>
    ),
    code: `const fame = collection({
  name: 'app.fame',
  schema: Fame, // the reactions it cites
  contract: { check: [contract(Fame, ({ body, versions }) =>
    versions(body.reactions).of(Reaction)
      .where((r) => r.body.emoji.eq('🙂'))
      .map((r) => r.author).distinct().count().gte(5),
    'Needs five different people')] },
});`,
    visual: CONTRACTS,
  },
  {
    id: 'sync',
    name: 'Sync & privacy',
    icon: 'M4 7.5h8v6.5H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
    intro:
      'Devices sync directly, encrypted end to end, and an invite link carries the space’s key. Relays only introduce devices, and an always-on node can keep a space online without being able to read it.',
    code: "await node.spaces.invite(space.id, { role: 'member' });",
    visual: SYNC,
  },
];
