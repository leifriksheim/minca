/**
 * The developers page's concepts, top to bottom: a few sentences each, a
 * line of code, and a small drawing in HTML and CSS.
 */
import type { ReactNode } from 'react';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';

export interface Concept {
  /** Its tab's id */
  readonly id: string;
  readonly name: string;
  /** Its tab's mark: one of the shapes that mean something, in its own colour */
  readonly shape: { readonly kind: ShapeKind; readonly colour: ShapeColour };
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
  <div
    className="viz"
    role="img"
    aria-label="A space: its founding rules, sealed by their hash, and its members' devices in sync"
  >
    <div className="viz-space">
      <div className="viz-caption">space · Bike co-op</div>
      <Box ink name="Founding rules">
        <small>top: no one, like a co-op</small>
        <small>roles: steward, member</small>
        <span className="viz-note">{LOCK} the space’s id is their hash</span>
      </Box>
      <div className="viz-row">
        <Box name="Ann" sub="steward" />
        <Box name="Bea" sub="member" />
        <Box name="Cy" sub="member" />
      </div>
    </div>
    <div className="viz-caption">⇄ synced between the members’ devices, sealed before it leaves</div>
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

const PERMISSIONS = (
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
  <div className="viz" role="img" aria-label="A claim attaches its proof, and every device checks it">
    <div className="viz-flow">
      <Box ink name="Claim: “this comment is in”" sub="proof: 5 reactions">
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
      bad proof, like four reactions or one person twice: the claim arrives, but counts for no one
    </div>
  </div>
);

const NODES = (
  <div
    className="viz"
    role="img"
    aria-label="The same node in a tab, an extension and a terminal, syncing directly; a relay and a host off to the side"
  >
    <div className="viz-caption">one node, the same everywhere</div>
    <div className="viz-row">
      <Box ink name="Browser tab" sub="IndexedDB" />
      <Box ink name="Extension" sub="keeps every space" />
      <Box ink name="Terminal" sub="a folder on disk" />
    </div>
    <span className="viz-arrow down">
      <span aria-hidden>⇄</span>
      <small className="viz-lock">{LOCK} directly, end to end</small>
    </span>
    <div className="viz-row">
      <Box name="Relay" sub="introduces them, then steps aside" />
      <Box name="Host" sub="keeps it online, can’t read it" />
    </div>
  </div>
);

export const CONCEPTS: ReadonlyArray<Concept> = [
  {
    id: 'identity',
    name: 'Identity',
    shape: { kind: 'key', colour: 'cobalt' },
    intro:
      'A person has one account: a recovery code they keep, or a passkey. Each device and app gets a key of its own, with a note from the account saying what that key may do. There is no user table for you to keep.',
    code: 'const me = await manager.fromRecoveryCode(password);',
    visual: IDENTITY,
  },
  {
    id: 'spaces',
    name: 'Spaces',
    shape: { kind: 'grid', colour: 'coral' },
    intro:
      'A space is a group’s shared data: its members, their roles and their records, kept on each member’s devices and synced between them. It starts from a few founding rules: who’s at the top (founders, or no one, like a co-op) and the roles it begins with. Its id is their hash, so nobody can swap them.',
    code: "const space = await node.spaces.create({\n  name: 'Bike co-op',\n  visibility: 'private',\n  ...rolePresets.coop, // no one at the top\n});",
    visual: SPACES,
  },
  {
    id: 'records',
    name: 'Records',
    shape: { kind: 'stack', colour: 'peach' },
    intro:
      'Data is typed records in collections, whose schemas live in the space. A record is a chain of signed versions, and its key says whose it is.',
    code: "const Task = z.object({\n  title: z.string(), done: z.boolean() });\n\nconst tasks = collection({\n  name: 'app.task', schema: Task,\n  // links and rules are optional\n});\nawait node.collections.define(\n  space.id, tasks);\nawait node.records.put(space.id, tasks,\n  { title: 'Ship v1', done: false });",
    visual: RECORDS,
  },
  {
    id: 'permissions',
    name: 'Permissions',
    shape: { kind: 'shield', colour: 'sage' },
    intro:
      'The group decides who may do what. A role holds grants, like “anything in app.hr”, and people hold roles. Nobody can hand out more than they may do themselves. Every device checks each change against them, and refuses what breaks them.',
    code: "await node.spaces.defineRole(space.id, {\n  name: 'hr',\n  grants: [{ cmd: '/record',\n    pol: [['==', '.collection', 'app.hr']] }],\n});\nawait node.spaces.assign(space.id, halDid, 'hr');",
    visual: PERMISSIONS,
  },
  {
    id: 'contracts',
    name: 'Contracts',
    shape: { kind: 'tick', colour: 'cobalt' },
    intro: (
      <>
        <p>
          A contract is a rule that every device checks the same way. Say a comment makes the hall of fame
          once five different people react 🙂. When the fifth 🙂 comes in, the app writes a claim, “this
          comment is in”, and attaches the five reactions as proof.
        </p>
        <p>
          Every device checks the proof for itself. If it holds, the claim counts. If it doesn’t, say four
          reactions, or one person twice, the claim still arrives but counts for no one. Like a smart
          contract, without a blockchain.
        </p>
        <p>
          Only showing a number? A computed field is enough: each device counts what it has. A contract is for
          when the result has to be a fact everyone agrees on.
        </p>
      </>
    ),
    code: `const fame = collection({
  name: 'app.fame',
  schema: Fame, // the reactions it cites
  contract: {
    check: ({ body, cited }) => ({
      'Needs five different people': cited(body.reactions, reaction)
        .where((r) => r.body.emoji.eq('🙂'))
        .map((r) => r.author).distinct().count().gte(5),
    }),
  },
});`,
    visual: CONTRACTS,
  },
  {
    id: 'apps',
    name: 'Apps',
    shape: { kind: 'pass', colour: 'lilac' },
    intro:
      'An app doesn’t get your account. It asks your account home for access, and you see what it wants: which spaces, read or write, for how long. Approve, and it gets a pass that says exactly that, which every device checks and you can take back anytime. It never sees your keys or password.',
    code: "const connection = createMincaConnection({\n  home: 'https://home.minca.social/connect',\n  request: { name: 'Polls', access: 'write',\n    scope: 'spaces' },\n});",
    visual: APPS,
  },
  {
    id: 'nodes',
    name: 'Nodes',
    shape: { kind: 'mesh', colour: 'coral' },
    intro:
      'A node is the whole engine in one object: identity, storage, sync and encryption. The same one runs in a browser tab, the Chrome extension, a terminal, a server or an agent, and they sync directly, encrypted end to end. Relays only introduce them, and a host keeps your spaces online while your devices sleep, without a key that could read them.',
    code: "const node = await createNode({\n  signer, // your account, or a pass from it\n  stores: indexedDBStores('my-app'),\n  network: { relays: ['wss://…'] },\n});\n// the same node at a terminal: minca run\n// online for others, unread: minca host",
    visual: NODES,
  },
];
