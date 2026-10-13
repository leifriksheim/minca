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

const SPACES = (
  <div className="viz" role="img" aria-label="A space: its constitution, and its members' devices in sync">
    <div className="viz-space">
      <div className="viz-caption">space · Bike co-op</div>
      <Box ink name="Constitution" sub="top: none · roles: steward, member" />
      <div className="viz-row">
        <Box name="Ann" sub="steward" />
        <Box name="Bea" sub="member" />
        <Box name="Cy" sub="member" />
      </div>
    </div>
    <div className="viz-caption">⇄ synced between the members’ devices</div>
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
    id: 'spaces',
    name: 'Spaces',
    icon: 'M2.5 2.5h11v11h-11zM5 6h6M5 9.5h3',
    intro:
      'A space is a group’s shared data, kept on each member’s devices and synced between them. It starts from its constitution: its founders, or no one at the top, and the roles it begins with.',
    code: "const space = await node.spaces.create(\n  { name: 'Club', visibility: 'private' });",
    visual: SPACES,
  },
  {
    id: 'records',
    name: 'Records',
    icon: 'M4 1.5h5.5l3 3v10h-8.5zM9.5 1.5v3h3',
    intro:
      'Data is typed records in collections, whose schemas live in the space. A record is a chain of signed versions, and its key says whose it is.',
    code: "await node.records.update(space.id, task.key,\n  { title: 'Ship v1.0', done: true });",
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
    intro:
      'Some results everyone must agree on: did the vote pass, does the balance cover it. Whoever claims one cites its proof, and every device checks it the same way. Smart contracts, without a blockchain.',
    code: 'await node.records.contracts(space.id, claim.key);\n// { passes: true }',
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
