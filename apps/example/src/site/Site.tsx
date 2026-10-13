import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import { CONNECT, SCENARIOS, type Scenario } from './walkthrough';
import './site.css';

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/** The site's pages (`/`, `/developers`, `/protocol`, `/extension`), sharing the example app's fonts and deploy */
export const GITHUB = 'https://github.com/leifriksheim/weave';
export const SPEC = `${GITHUB}/tree/main/spec`;
/** Links off the site open in a tab of their own */
export const EXTERNAL = { target: '_blank', rel: 'noreferrer' } as const;

function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <path
        d="M2 5 L7 15 L10 8 L13 15 L18 5"
        fill="none"
        stroke="#000"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

type PageName = 'home' | 'developers' | 'protocol' | 'extension';

function Nav({ page }: { page: PageName }) {
  return (
    <header className="nav">
      <div className="wrap">
        <a href="/" className="brand">
          <Mark />
          Weave
        </a>
        <nav className="nav-links">
          <a href="/developers" aria-current={page === 'developers' ? 'page' : undefined}>
            Developers
          </a>
          <a href="/protocol" aria-current={page === 'protocol' ? 'page' : undefined}>
            Protocol
          </a>
          <a href="/extension" aria-current={page === 'extension' ? 'page' : undefined} className="hide-sm">
            Extension
          </a>
          <a href={GITHUB} {...EXTERNAL} className="hide-sm">
            GitHub
          </a>
          <a href="/app" className="btn btn-primary" style={{ color: '#fff', marginLeft: 8 }}>
            Open app
          </a>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <span>Weave — the internet, owned by its people.</span>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <a href="/">Communities</a>
          <a href="/developers">Developers</a>
          <a href="/protocol">Protocol</a>
          <a href="/extension">Chrome extension</a>
          <a href={SPEC} {...EXTERNAL}>
            Spec
          </a>
          <a href={GITHUB} {...EXTERNAL}>
            GitHub
          </a>
          <a href="/app">Open app</a>
        </span>
      </div>
    </footer>
  );
}

export function Page({ page, children }: { page: PageName; children: ReactNode }) {
  return (
    <div className="site">
      <Nav page={page} />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

/** A small line icon, drawn the same way as the mark */
function Icon({ d }: { d: string }) {
  return (
    <span className="icon">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="#000"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={d} />
      </svg>
    </span>
  );
}

/** A band of a page: a kicker, a heading and a line or two on what it is about, then the band itself */
export function Band({
  id,
  kicker,
  title,
  intro,
  children,
}: {
  id?: string;
  kicker: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="band" id={id}>
      <div className="wrap">
        <div className="section-head">
          <div className="kicker">{kicker}</div>
          <h2>{title}</h2>
          {intro}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Short points side by side, each a heading and a sentence or two */
export function Points({ points }: { points: ReadonlyArray<{ title: string; body: ReactNode }> }) {
  return (
    <div className="points">
      {points.map((point) => (
        <div key={point.title}>
          <h3>{point.title}</h3>
          <p>{point.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Feature({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="cell">
      <Icon d={icon} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/**
 * The highlighter calls `define` in `node.collections.define(…)` a property,
 * like `records`. A name right before `(` is a call; mark it as one, so calls
 * stand out the way they do in an editor.
 */
function markCalls<P extends ReturnType<typeof parse>>(parsed: P): P {
  for (const line of parsed.lines) {
    const tokens = line.tokens;
    tokens.forEach((token, i) => {
      const next = tokens[i + 1];
      if (
        (token.type === 'identifier' || token.type === 'property') &&
        next?.type === 'sign' &&
        next.value.startsWith('(')
      )
        token.type = 'entity';
    });
  }
  return parsed;
}

function Code({
  file,
  lang = 'typescript',
  children,
}: {
  file: string;
  lang?: keyof typeof LANGUAGES;
  children: string;
}) {
  // Our own code snippets, not user input — safe to render as HTML.
  const html = render(markCalls(parse(children.trim(), LANGUAGES[lang])));
  return (
    <div className="code">
      <div className="bar">
        <span>{file}</span>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// ─── For developers ─────────────────────────────────────────────────

const CONTRACT_DECIDED = `
import { proposal, ballot, decision, type Ballot } from '@weaveprotocol/core/schemas';

// 1. Put it to the group: five ballots for one option decide it
const paint = await node.records.put(space.id, proposal, {
  title: 'Paint the clubhouse?', options: ['Yes', 'No'], quorum: 5,
});
const about = [{ rel: 'about', to: paint.key }];

// 2. Members cast ballots: one each, and they can't be changed
await node.records.put(space.id, ballot, { choice: 0 }, { links: about });

// 3. Anyone who sees five "Yes" claims the result, citing the proof
const yes = (await node.records.linked<Ballot>(space.id, paint.key,
  { rel: 'about', collection: ballot.name }))
  .filter((b) => b.body?.choice === 0);

const decided = await node.records.put(space.id, decision, {
  outcome: 0,
  proposal: paint.version,
  ballots: yes.map((b) => b.version), // the exact ballots, by id
}, { links: about });

// 4. Every device checks the proof, and gets the same answer
await node.records.contracts(space.id, decided.key);
// { passes: true }. With four ballots, one person twice, or a
// forged ballot: { passes: false }. It still syncs; it counts for no one.
`;

const CONTRACT_OWN = `
import { contract } from '@weaveprotocol/core';

// Your own rule, typed from the schema: fields autocomplete,
// and a wrong comparison won't compile. A score only goes up by one:
rules: {
  check: [
    contract(Score, ({ body, prev }) =>
      prev.eq(null).or(body.score.eq(prev.body.score.add(1))),
      'The score goes up by one'),
  ],
}
`;

const SCHEMAS = `
import {
  poll, vote, reaction, useSchemas,
} from '@weaveprotocol/core/schemas';

// A poll ships ready-made, as std.poll and std.vote
await useSchemas(node, space.id, [poll, vote, reaction]);

const lunch = await node.records.put(space.id, poll, {
  question: 'Pizza or tacos?', options: ['Pizza', 'Tacos'],
});

// Any app that knows std.poll can show it and count it,
// and a reaction from any app lands on it too
await node.records.put(space.id, reaction.name, { emoji: '🍕' }, {
  links: [{ rel: 'about', to: lunch.key }],
});
`;

const AGENTS = `
# Every node operation, from a terminal
weave spaces list
weave records query --space <id> \\
  --collection app.poll \\
  --where '{"question":{"$contains":"may"}}'

# An always-on node: keeps your spaces
# available, and relays for your devices
weave run

# Connect an agent (Claude Code, Claude Desktop, Cursor) with the
# code from "Connect an agent" in an app; it then serves MCP by itself
weave connect wv_…
`;

const PROTOCOLS = ['Weave', 'AT Protocol (Bluesky)', 'Nostr', 'Solid'] as const;

/** The case for rules without a referee, in four points */
const CONSENSUS: ReadonlyArray<Part> = [
  {
    title: 'Roles you design',
    body: 'Admin, moderator, guest, or whatever your app needs. Each role holds grants: what it may do, and on what. They live in the space, not in your code, and the space’s founders sit above them, or no one does.',
  },
  {
    title: 'Every device is the referee',
    body: 'When a change arrives, each device checks who made it and whether their role allowed it, and refuses what breaks the rules. Devices that were offline, or saw changes in another order, reach the same verdict. No leader, no server, no vote to wait for.',
  },
  {
    title: 'Founded with a constitution',
    body: 'A space starts from its constitution: who founded it, and how conflicts resolve. Founders can’t be pushed out, but can step down. Or a space has no one at the top, like a co-op. To change the founding rules, members move to a successor space and each chooses whether to follow.',
  },
  {
    title: 'Access you can take back',
    body: 'Remove someone or disconnect an app, and from then on their changes stop counting on every device. Backdating a change doesn’t get around it.',
  },
];

/** How a contract works, in four steps */
const CONTRACT_STEPS: ReadonlyArray<Part> = [
  {
    title: '1. Someone claims a result',
    body: 'Alice’s app sees five “Yes” ballots and writes a decision: “Yes won”. Any member’s app can; nobody is in charge of counting.',
  },
  {
    title: '2. The claim brings its proof',
    body: 'The decision cites the five ballots by their exact ids. The proof is part of the record, so it travels with it.',
  },
  {
    title: '3. The rule travels with the data',
    body: 'The decision collection carries its contract: “counts only with ballots from five different members, all for this option”. Every app and agent sees the same rule.',
  },
  {
    title: '4. Every device checks',
    body: 'Same records in, same verdict out, on every device, whenever the decision arrives. Four ballots, a double vote or a forgery: it syncs, and counts for no one.',
  },
];

/** What contracts make possible, without a server or a chain */
const CONTRACTS: ReadonlyArray<Part> = [
  {
    title: 'Decided when enough agree',
    body: 'A proposal passes or a reward is released only with enough signed approvals behind it. Three of five admins, ten members, whatever the space decides. (Votes that change who holds power are next on the roadmap.)',
  },
  {
    title: 'Moves that must be legal',
    body: 'Each version is checked against the one before, so a game, a workflow or an order can only move the way its rules allow.',
  },
  {
    title: 'Points that add up',
    body: 'Credits, badges and balances that cite the records they came from. Every device checks the sums.',
  },
  {
    title: 'Fair dice',
    body: 'Commit to a hidden value, reveal it later, and every device checks it matches: randomness with nobody to trust. What needs a deadline, like an auction that closes Friday, needs a witness, which is on the roadmap.',
  },
];

/** One row per question: the question, then an answer for each protocol, in order */
const COMPARISON: ReadonlyArray<readonly [string, string, string, string, string]> = [
  [
    'Built for',
    'Private and shared app data',
    'Public social media',
    'Public messages that can’t be censored',
    'Personal data stores',
  ],
  [
    'Where data lives',
    'On the user’s devices, or a folder they own',
    'A personal data server, usually hosted',
    'Relays the user publishes to',
    'A pod server',
  ],
  [
    'Servers you need',
    'None. Relays only introduce devices',
    'Data servers, relays and app views',
    'Relays, which store and serve everything',
    'A pod server per user or provider',
  ],
  [
    'Private data',
    'Encrypted end to end by default',
    'Public by design',
    'Public, with encrypted direct messages',
    'Access control on the server',
  ],
  ['Works offline', 'Yes, local-first', 'No', 'Reading from cache', 'No'],
  [
    'Several people editing the same data',
    'Yes, shared spaces',
    'No, each user writes their own',
    'No, each user writes their own',
    'Yes, through permissions',
  ],
  [
    'Account',
    'A password or passkey the user keeps',
    'A DID and a handle, with a server holding the keys',
    'A key pair, and losing it is final',
    'A login with an identity provider',
  ],
  [
    'Who enforces the rules',
    'Every device, and they all agree',
    'Each app’s servers and moderation services',
    'Each relay and client, separately',
    'The pod server',
  ],
  ['Public feeds at global scale', 'Not the goal', 'Yes, that’s its strength', 'Yes, across relays', 'No'],
];

/** One piece of a layer, told at a high level */
interface Part {
  readonly title: string;
  readonly body: ReactNode;
}

/**
 * A layer of the stack: a line on what it does, and its parts underneath. The
 * whole line opens it; the page keeps one open at a time.
 */
function Layer({
  name,
  what,
  parts,
  app,
  open,
  onToggle,
}: {
  name: string;
  what: string;
  parts: ReadonlyArray<Part>;
  app?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <div className={app ? 'layer app' : 'layer'}>
      <button type="button" className="layer-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="name">{name}</span>
        <span className="what">{what}</span>
        <span className="more">{open ? 'Show less' : 'Read more'}</span>
      </button>
      <div id={id} className="parts" hidden={!open}>
        {parts.map((part) => (
          <div key={part.title} className="part">
            <h4>{part.title}</h4>
            <p>{part.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Where each of the walkthrough's steps falls among the five */
const STEP_NUMBER: Readonly<Record<string, number>> = {
  'Start the space': 1,
  'Describe the data': 2,
  'Say who may do what': 3,
  'Say what counts': 3,
  'Use it': 4,
  'What it shows': 5,
  'What it proves': 5,
};

/** The scenario the URL's hash names (`#coop`), or the first */
function scenarioFromHash(): string {
  const id = typeof location === 'undefined' ? '' : location.hash.slice(1);
  return SCENARIOS.some((s) => s.id === id) ? id : (SCENARIOS[0]?.id ?? '');
}

/**
 * Tabs, one per scenario: arrow keys, Home and End move between them, and
 * the chosen one is kept in the URL's hash.
 */
function Walkthrough() {
  const [selected, setSelected] = useState(scenarioFromHash);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const base = useId();
  useEffect(() => {
    // A link to #coop opens the walkthrough on the co-op
    if (location.hash.slice(1) === scenarioFromHash())
      document.getElementById('walkthrough')?.scrollIntoView();
    const onHash = () => setSelected(scenarioFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const choose = (id: string) => {
    setSelected(id);
    history.replaceState(null, '', `#${id}`);
  };
  const onKey = (event: KeyboardEvent, index: number) => {
    const last = SCENARIOS.length - 1;
    const to =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    const next = to === null ? undefined : SCENARIOS[to];
    if (!next) return;
    event.preventDefault();
    choose(next.id);
    tabs.current[to ?? 0]?.focus();
  };
  const current: Scenario | undefined = SCENARIOS.find((s) => s.id === selected) ?? SCENARIOS[0];
  return (
    <>
      <div className="split walk-step">
        <div>
          <div className="step-label">First</div>
          <h3>Connect</h3>
          <p>
            A node is the whole stack: give it something that signs for the user, somewhere to store things,
            and relays to meet peers. It handles keys, encryption, checking and sync. Every tab below starts
            here.
          </p>
        </div>
        <Code file="node.ts">{CONNECT}</Code>
      </div>
      <div className="tabs" role="tablist" aria-label="Scenarios">
        {SCENARIOS.map((scenario, i) => (
          <button
            key={scenario.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${scenario.id}-tab`}
            aria-selected={scenario.id === current?.id}
            aria-controls={`${base}-${scenario.id}`}
            tabIndex={scenario.id === current?.id ? 0 : -1}
            onClick={() => choose(scenario.id)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {scenario.name}
          </button>
        ))}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`${base}-${current.id}`}
          aria-labelledby={`${base}-${current.id}-tab`}
          className="tab-panel"
        >
          <p className="tab-summary">{current.summary}</p>
          {current.steps.map((step) => (
            <div key={step.label} className="split walk-step">
              <div>
                <div className="step-label">Step {STEP_NUMBER[step.label]}</div>
                <h3>{step.label}</h3>
                <p>{step.text}</p>
              </div>
              <Code file={step.file}>{step.code}</Code>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Developers() {
  const [openLayer, setOpenLayer] = useState<string | null>(null);
  const toggle = (name: string) => ({
    open: openLayer === name,
    onToggle: () => setOpenLayer(openLayer === name ? null : name),
  });
  return (
    <Page page="developers">
      <section className="hero">
        <div className="wrap">
          <h1>
            Build apps on data
            <br />
            people own.
          </h1>
          <p>
            Identity, storage, sync and encryption in one library. No backend to run, no database to host —
            your users bring their data, and your app is a view on it.
          </p>
          <div className="actions">
            <span className="install">
              <span>$</span>
              <code>npm install @weaveprotocol/core</code>
            </span>
            <a href="/app" className="btn btn-secondary">
              See the example app
            </a>
          </div>
        </div>
      </section>

      <Band
        id="walkthrough"
        kicker="How it fits together"
        title="One space, start to finish."
        intro={
          <p>
            Every app on Weave does the same five things: start a space, describe its data, say who may do
            what, use it, and read what it shows or proves. Pick a community to see them in its terms; each
            one runs as a test in the repository.
          </p>
        }
      >
        <Walkthrough />
      </Band>

      <Band
        kicker="Rules without a referee"
        title="Everyone follows the rules. Nobody is in charge."
        intro={
          <p>
            Most apps trust a server to decide who may do what. Weave has no server to trust, so every device
            decides, and they all reach the same answer.
          </p>
        }
      >
        <Points points={CONSENSUS} />
      </Band>

      <Band
        kicker="Contracts"
        title="Smart contracts, without a blockchain."
        intro={
          <>
            <p>
              Some results a group has to agree on: did the vote pass, does the balance cover it, was that a
              legal move. A blockchain gets everyone to agree by putting every event in one global order, then
              running the code. Weave turns it around:
            </p>
            <p>
              <strong>Whoever claims a result brings the proof. Every device checks it.</strong> Checking a
              proof needs no order, no server and no consensus, and it works offline.
            </p>
          </>
        }
      >
        <Points points={CONTRACT_STEPS} />
        <div className="split">
          <div>
            <h3>A vote, start to finish</h3>
            <p>
              The standard <code>std.proposal</code>, <code>std.ballot</code> and <code>std.decision</code>{' '}
              collections ship with their contract. Put something to the group, let people vote, and let
              anyone record the outcome: if the ballots they cite don’t add up, no device counts it.
            </p>
          </div>
          <div className="stack">
            <Code file="decide.ts">{CONTRACT_DECIDED}</Code>
          </div>
        </div>
        <Points points={CONTRACTS} />
        <div className="split">
          <div>
            <h3>The app proves it, every device checks</h3>
            <p>
              A contract never goes looking for records. The app that writes does the work: it finds the
              ballots and cites them. Every other device only checks that what was cited proves it, so they
              all reach the same verdict, whenever they see it. A version that fails is still kept and synced;
              it just doesn't count.
            </p>
            <p>
              Write one in TypeScript with <code>contract(…)</code>, typed from your schema. It's stored with
              the collection as CEL, so it travels with the data and every app and agent sees the same rule.
              It always finishes and reads no clock.
            </p>
            <ul>
              <li>
                Ready-made: <code>std.decision</code> for proposals, <code>std.goal-reached</code> for pledges
              </li>
              <li>
                Or your own, over the record, the version before it, and what it cites; read a verdict with{' '}
                <code>records.contracts</code>
              </li>
              <li>
                Payments and balances: a <code>line</code> makes each account's versions one sequence, so
                spending twice cancels out
              </li>
            </ul>
          </div>
          <div className="stack">
            <Code file="rules.ts">{CONTRACT_OWN}</Code>
          </div>
        </div>
      </Band>

      <Band
        kicker="The layers"
        title="What's underneath, top to bottom."
        intro={
          <p>
            Follow one vote down the stack. Your app writes it. It's checked against its schema and the
            space's rules, encrypted, signed, saved on the device, and synced to everyone else. You only touch
            the top layer, and you can swap the pieces underneath.
          </p>
        }
      >
        <div className="layers">
          <Layer
            app
            name="Your app"
            {...toggle('Your app')}
            what="You write the front end. There's no backend to build, host or pay for."
            parts={[
              {
                title: 'No backend to build',
                body: 'Storage, sync, sign-in and permissions come in one object. Put a record, query it, watch it change. That’s the whole server side.',
              },
              {
                title: 'Bring your own stack',
                body: 'Plain TypeScript, with React hooks if you want them. Describe your data with Zod, Valibot, ArkType or plain JSON Schema.',
              },
              {
                title: 'Sign-in you don’t write',
                body: 'One element or one hook. Accounts, passkeys and pairing a phone are built in. The person’s account home asks them first, then gives your app a signed, expiring pass: which spaces, and for how long. Your app never sees their password or keys, and they can take the pass back.',
              },
              {
                title: 'Ready for agents',
                body: 'Every operation is also a CLI command and an MCP tool, so AI agents can work with the same data, with the same permissions as your app.',
              },
            ]}
          />
          <Layer
            name="Data"
            {...toggle('Data')}
            what="A database that ships with the data: schemas, queries, live updates and permissions."
            parts={[
              {
                title: 'Start with your users’ data',
                body: 'When someone lets your app into their spaces, their data is already there. No blank slate, no import step.',
              },
              {
                title: 'The schema travels with the data',
                body: 'The shape of your data is stored next to it, so another app, or an agent, can make sense of it without your docs.',
              },
              {
                title: 'Apps that work together',
                body: 'Use the standard schemas, and a poll asked in one app can be voted on in another. No integration to build, no partnership to sign.',
              },
              {
                title: 'Queries you already know',
                body: 'Filters, sorting, paging and related records, in plain JSON. Results update live as changes arrive.',
              },
              {
                title: 'Rules instead of an API',
                body: 'Roles say who may write and delete. Rules say what must be unique, which fields are fixed, and what a record must prove. Every device enforces them, so there’s no permission server to write.',
              },
              {
                title: 'Collaboration included',
                body: 'Shared spaces with invite links. Several people edit, and every device lands on the same result, without you writing merge logic.',
              },
            ]}
          />
          <Layer
            name="Privacy"
            {...toggle('Privacy')}
            what="Encrypted before it's saved or sent. You can't leak what you never had."
            parts={[
              {
                title: 'Encrypted first',
                body: 'Private data is encrypted on the device before it’s stored or sent. Relays, and always-on nodes that hold no keys, pass it along without being able to read it.',
              },
              {
                title: 'Less to be responsible for',
                body: 'Your users’ private data never sits readable on your servers, so there’s far less for you to secure.',
              },
              {
                title: 'Sharing that stays private',
                body: 'An invite link carries its own key, so sharing a private space never goes through a server.',
              },
              {
                title: 'Private or public, per space',
                body: 'Spaces are private by default. Make one public when anyone with the link should be able to read it.',
              },
            ]}
          />
          <Layer
            name="Identity & auth"
            {...toggle('Identity & auth')}
            what="Every change is signed by whoever made it. No user table for you to guard."
            parts={[
              {
                title: 'No user table',
                body: 'Accounts aren’t stored with you. There’s no password database to protect, and nothing to leak.',
              },
              {
                title: 'One account, every app',
                body: 'People make an account once, on their own device, with a recovery code to keep safe, and sign in with a passkey or a password. There’s no sign-up form, and they use it in every Weave app. No company keeps a copy or can shut it off.',
              },
              {
                title: 'Everything is signed',
                body: 'Every change carries the signature of whoever made it, even when it’s encrypted. So any device can check who did what, even ones that can’t read it.',
              },
              {
                title: 'Any signer',
                body: 'A key in the browser, an account home, or anything else that can sign. Nothing above this layer needs to know which.',
              },
            ]}
          />
          <Layer
            name="Storage"
            {...toggle('Storage')}
            what="Kept on your users' devices, so your app is fast, works offline, and isn't on your bill."
            parts={[
              {
                title: 'Fast, because it’s local',
                body: 'Reads and writes happen on the device. No round trip to a server, no loading spinners.',
              },
              {
                title: 'Offline by default',
                body: 'Your app keeps working on a plane, and catches up when it’s back online.',
              },
              {
                title: 'One folder, every app',
                body: 'Keep data in the browser, or in a folder on the person’s own computer. Every app they use, on any website, sees the same folder.',
              },
              {
                title: 'No database bill',
                body: 'You don’t store your users’ data, so more users don’t mean a bigger database.',
              },
            ]}
          />
          <Layer
            name="Network & sync"
            {...toggle('Network & sync')}
            what="Devices sync directly. You don't run the servers in between."
            parts={[
              {
                title: 'Live, device to device',
                body: 'Changes go straight between devices and show up in real time. A new phone joins by scanning a code, or with the recovery code.',
              },
              {
                title: 'Relays you choose',
                body: 'Relays help devices find each other, and can’t read what passes through them. Use a public one, run your own, or several at once.',
              },
              {
                title: 'Sends only what changed',
                body: 'However big a space gets, syncing costs about as much as the change itself.',
              },
              {
                title: 'Online when devices sleep',
                body: 'An always-on node, the user’s own or a host’s, keeps data available while their devices are off. It can be one that holds no keys, passing data along without reading it.',
              },
              {
                title: 'Nothing bad gets in',
                body: 'Every change is checked on arrival: who signed it, its shape, and whether they were allowed. The rest is dropped.',
              },
            ]}
          />
        </div>
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>Or use the standard ones</h3>
              <p>
                The protocol has no built-in kinds of record. For the things nearly every app needs, there's
                an optional library of ready-made definitions.
              </p>
              <p>
                They're ordinary collections, nothing special. Using the same ones is simply how two apps
                agree: a poll asked in one can be voted on in another. Prefer your own shape? Define your own.
              </p>
              <ul>
                <li>
                  On anything: <code>reaction</code>, <code>comment</code>, <code>tag</code>,{' '}
                  <code>attachment</code>, <code>reference</code>
                </li>
                <li>
                  Things of their own: <code>message</code>, <code>task</code>, <code>column</code>,{' '}
                  <code>poll</code>, <code>vote</code>
                </li>
                <li>
                  <code>useSchemas</code> defines only what a space is missing
                </li>
              </ul>
            </div>
            <Code file="standard.ts">{SCHEMAS}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Built for agents, too</h3>
              <p>
                Every operation is described once — a name, a sentence, a JSON Schema — and becomes a CLI
                command, an MCP tool and a WebMCP tool in the browser.
              </p>
              <p>An agent acts as the user, with the same permissions as the app it's in.</p>
            </div>
            <Code file="terminal" lang="shell">
              {AGENTS}
            </Code>
          </div>
        </div>
      </section>

      <Band
        kicker="Compared"
        title="Where Weave fits."
        intro={
          <p>
            Other open protocols give people their data back too. They make different bets. Weave is for apps
            where data is private, shared between a few people, and works offline.
          </p>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th />
                {PROTOCOLS.map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map(([row, ...cells]) => (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  {cells.map((cell, i) => (
                    <td key={PROTOCOLS[i]}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Band>

      <section className="cta">
        <div className="wrap">
          <h2>Start with the example.</h2>
          <p>
            A general app for any Weave data — every screen worked out from what a space says about itself.
          </p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Open the example app
            </a>
            <a href="/protocol" className="btn btn-secondary">
              How it works
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
