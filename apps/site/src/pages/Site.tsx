import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import { STAFF_COLLECTIONS } from '@minca/core';
import { Mark } from '@minca/app-shared/Wordmark';
import { Shape, type ShapeKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';
import { CONCEPTS } from './concepts';

import { CONNECT, SCENARIOS, describePreset } from './walkthrough';
import './site.css';

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/** The site's pages (`/`, `/developers`, `/protocol`, `/extension`, `/download`), on the same design system as the app */
export const GITHUB = 'https://github.com/leifriksheim/minca';
export const SPEC = `${GITHUB}/tree/main/spec`;
/** Links off the site open in a tab of their own */
export const EXTERNAL = { target: '_blank', rel: 'noreferrer' } as const;
/** The app, a site of its own (`apps/example`), which every "Open Minca" opens */
export const APP = import.meta.env.VITE_MINCA_APP ?? 'https://app.minca.social';

type PageName = 'home' | 'developers' | 'protocol' | 'extension' | 'download';

/** GitHub's mark, in the colour of the text beside it */
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Nav({ page }: { page: PageName }) {
  return (
    <header className="nav">
      <div className="wrap">
        <Link to="/" className="brand">
          <Mark />
          minca
        </Link>
        <nav className="nav-links">
          <Link to="/developers" aria-current={page === 'developers' ? 'page' : undefined}>
            For nerds
          </Link>
          <Link to="/download" aria-current={page === 'download' ? 'page' : undefined}>
            Download
          </Link>
          <a href={GITHUB} {...EXTERNAL}>
            <GitHubMark />
            GitHub
          </a>
          <a href={APP} className="btn btn-primary" style={{ marginLeft: 8 }}>
            Open Minca
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
        <span className="footer-brand">
          <Mark size={18} />
          Many hands, one minca.
        </span>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Link to="/">Communities</Link>
          <Link to="/developers">For nerds</Link>
          <Link to="/protocol">Protocol</Link>
          <Link to="/download">Download</Link>
          <Link to="/extension">Chrome extension</Link>
          <a href={SPEC} {...EXTERNAL}>
            Spec
          </a>
          <a href={GITHUB} {...EXTERNAL}>
            GitHub
          </a>
          <a href={APP}>Open Minca</a>
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
        stroke="currentColor"
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

/** A band of a page: a kicker if it needs one, a heading and a line or two on what it is about, then the band itself */
export function Band({
  id,
  tone,
  kicker,
  title,
  intro,
  children,
}: {
  id?: string;
  /** `sunken` sets the band on the warmer paper, edged with the navy rule */
  tone?: 'sunken';
  kicker?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={tone ? `band ${tone}` : 'band'} id={id}>
      <div className="wrap">
        <div className="section-head">
          {kicker ? <div className="kicker">{kicker}</div> : null}
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
  file?: string;
  lang?: keyof typeof LANGUAGES;
  children: string;
}) {
  // Our own code snippets, not user input — safe to render as HTML.
  const html = render(markCalls(parse(children.trim(), LANGUAGES[lang])));
  return (
    <div className="code">
      {file && (
        <div className="bar">
          <span>{file}</span>
        </div>
      )}
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// ─── For developers ─────────────────────────────────────────────────

const SCHEMAS = `
import {
  poll, vote, reaction, useSchemas,
} from '@minca/core/schemas';

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
minca spaces list
minca records query --space <id> \\
  --collection app.poll \\
  --where '{"question":{"$contains":"may"}}'

# An always-on node: keeps your spaces
# available, and relays for your devices
minca run

# Connect an agent (Claude Code, Cursor, VS Code, …) with the
# code from "Connect an agent" in an app; it then serves MCP by itself
minca connect mc_…
`;

const PROTOCOLS = ['Minca', 'AT Protocol (Bluesky)', 'Nostr', 'Solid'] as const;

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

/** The scenario a hash names (`coop`), or the first */
function scenarioFrom(hash: string): string {
  return SCENARIOS.some((s) => s.id === hash) ? hash : (SCENARIOS[0]?.id ?? '');
}

/** The index arrow keys, Home and End move to from `index`, or null for any other key */
function tabTarget(key: string, index: number, last: number): number | null {
  if (key === 'ArrowRight') return index === last ? 0 : index + 1;
  if (key === 'ArrowLeft') return index === 0 ? last : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/**
 * Tabs and the chosen one's panel: arrow keys, Home and End move between
 * them. The caller keeps which one is chosen.
 */
function Tabs<
  T extends {
    readonly id: string;
    readonly name: string;
    readonly shape?: { readonly kind: ShapeKind; readonly colour: ShapeColour };
  },
>({
  label,
  items,
  selected,
  onSelect,
  children,
}: {
  label: string;
  items: ReadonlyArray<T>;
  selected: string;
  onSelect: (id: string) => void;
  children: (item: T) => ReactNode;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const base = useId();
  const current = items.find((item) => item.id === selected) ?? items[0];
  const onKey = (event: KeyboardEvent, index: number) => {
    const to = tabTarget(event.key, index, items.length - 1);
    const next = to === null ? undefined : items[to];
    if (to === null || !next) return;
    event.preventDefault();
    onSelect(next.id);
    tabs.current[to]?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {items.map((item, i) => (
          <button
            key={item.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${item.id}-tab`}
            aria-selected={item.id === current?.id}
            aria-controls={`${base}-${item.id}`}
            tabIndex={item.id === current?.id ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {item.shape && <Shape kind={item.shape.kind} colour={item.shape.colour} size={18} />}
            {item.name}
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
          {children(current)}
        </div>
      )}
    </>
  );
}

/** The concepts, one tab each: a few sentences and a line of code, beside a drawing */
function Concepts() {
  const [selected, setSelected] = useState(CONCEPTS[0]?.id ?? '');
  return (
    <Tabs label="Concepts" items={CONCEPTS} selected={selected} onSelect={setSelected}>
      {(concept) => (
        <div className="concept">
          <div>
            <h3>{concept.name}</h3>
            {typeof concept.intro === 'string' ? (
              <p>{concept.intro}</p>
            ) : (
              <div className="concept-intro">{concept.intro}</div>
            )}
            {concept.code && <Code>{concept.code}</Code>}
          </div>
          {concept.visual}
        </div>
      )}
    </Tabs>
  );
}

/** What a preset a step spreads holds, written out under its code */
function Preset({ name }: { name: Parameters<typeof describePreset>[0] }) {
  const preset = describePreset(name);
  return (
    <div className="preset">
      <div className="preset-head">
        What <code>rolePresets.{preset.name}</code> contains
      </div>
      <p>{preset.top}</p>
      {preset.roles.map((role) => (
        <div key={role.name} className="preset-role">
          <h4>{role.name}</h4>
          <dl>
            {role.lines.map((line) => (
              <div key={line.when}>
                <dt>{line.when}</dt>
                <dd>
                  {line.cmds.map((cmd) => (
                    <code key={cmd}>{cmd}</code>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {preset.staff && <p className="preset-foot">Staff collections: {STAFF_COLLECTIONS.join(', ')}.</p>}
    </div>
  );
}

/** One tab per scenario, the chosen one kept in the URL's hash */
function Walkthrough() {
  const hash = useLocation({ select: (location) => location.hash });
  const selected = scenarioFrom(hash);
  const navigate = useNavigate();
  const [linked] = useState(() => hash === selected);
  useEffect(() => {
    // A link to #coop opens the walkthrough on the co-op
    if (linked) document.getElementById('walkthrough')?.scrollIntoView();
  }, [linked]);
  const choose = (id: string) =>
    void navigate({ hash: id, replace: true, resetScroll: false, hashScrollIntoView: false });
  return (
    <>
      <div className="split walk-step">
        <div>
          <div className="step-label">First</div>
          <h3>Connect</h3>
          <p>
            Every app starts the same way. Give a node something that signs for the user, somewhere to keep
            things, and relays to meet peers. Keys, encryption, checks and sync are its job from there. Each
            community below picks up here.
          </p>
        </div>
        <Code file="node.ts">{CONNECT}</Code>
      </div>
      <Tabs label="Scenarios" items={SCENARIOS} selected={selected} onSelect={choose}>
        {(scenario) => (
          <>
            <div className="scenario-head">
              <Shape kind={scenario.shape.kind} colour={scenario.shape.colour} size={48} />
              <div>
                <h3>{scenario.name}</h3>
                <p>{scenario.summary}</p>
                <a href={`${GITHUB}/blob/main/scenarios/communities/${scenario.test}`} {...EXTERNAL}>
                  Runs as a test: scenarios/communities/{scenario.test} →
                </a>
              </div>
            </div>
            {scenario.steps.map((step) => (
              <div key={step.label} className="split walk-step">
                <div>
                  <div className="step-label">Step {STEP_NUMBER[step.label]}</div>
                  <h3>{step.label}</h3>
                  <p>{step.text}</p>
                </div>
                <div className="stack">
                  <Code file={step.file}>{step.code}</Code>
                  {step.preset && <Preset name={step.preset} />}
                </div>
              </div>
            ))}
          </>
        )}
      </Tabs>
    </>
  );
}

export function Developers() {
  return (
    <Page page="developers">
      <section className="hero big-hero">
        <div className="wrap">
          <h1>
            A backend that
            <br />
            runs nowhere.
          </h1>
          <p>
            Let your users be your infrastructure: their devices keep the data, check the rules and sync with
            each other. No servers to run, and nothing in the middle that can read it.
          </p>
          <div className="actions">
            <span className="install">
              <span>$</span>
              <code>npm install @minca/core</code>
            </span>
            <a href={APP} className="btn btn-secondary">
              See the example app
            </a>
          </div>
        </div>
      </section>

      <Band
        id="concepts"
        kicker="The concepts"
        title="A protocol for any kind of social space."
        intro={
          <p>
            Minca was built to enable decentralized governance without a blockchain. These are the parts it's
            made of, and every app on it uses them.
          </p>
        }
      >
        <Concepts />
      </Band>

      <Band
        id="walkthrough"
        kicker="How it fits together"
        title="For any kind of community."
        intro={
          <p>
            Every app on Minca does the same few things: start a space, describe its data, say who may do
            what, use it, and read what it shows or proves. Pick a community to see them in its terms. Each
            one runs, step by step, as a test in the repository.
          </p>
        }
      >
        <Walkthrough />
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
        title="Where Minca fits."
        intro={
          <p>
            Other open protocols give people their data back too. They make different bets. Minca is for apps
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
            A general app for any Minca data — every screen worked out from what a space says about itself.
          </p>
          <div className="actions">
            <a href={APP} className="btn btn-primary">
              Open the example app
            </a>
            <Link to="/protocol" className="btn btn-secondary">
              How it works
            </Link>
          </div>
        </div>
      </section>
    </Page>
  );
}
