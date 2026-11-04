import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import { STAFF_COLLECTIONS } from '@minca/core';
import { Shape } from '@minca/app-shared/shapes';
import { CONCEPTS } from './concepts';
import { CONNECT, SCENARIOS, describePreset } from './walkthrough';
import { Band, EXTERNAL, GITHUB, Page, Tabs } from './Site';
import './Developers.css';

/** The developers' page: building on @minca/core, a walk through a scenario, and how Minca compares */

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/** The guides to building on `@minca/core`, which ship in the package */
const DOCS = `${GITHUB}/tree/main/packages/core/docs`;

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

/** A button that copies `text`, and says so for a moment */
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

# Connect an agent (Claude Code, Cursor, VS Code, …): opens your
# account home to allow it; it then serves MCP by itself
minca connect
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
            Your users’ devices keep the data, check the rules and sync with each other. No servers to run,
            and nothing in the middle that can read it.
          </p>
          <div className="actions">
            <span className="install">
              <span>$</span>
              <code>npm install @minca/core</code>
            </span>
            <a href={DOCS} data-intent="secondary" {...EXTERNAL}>
              Read the docs
            </a>
            <Link to="/protocol" data-intent="secondary">
              For supernerds
            </Link>
          </div>
        </div>
      </section>

      <Band
        id="concepts"
        kicker="The concepts"
        title="A protocol for any kind of social space."
        intro={<p>Minca lets a group run itself, without a blockchain.</p>}
      >
        <Concepts />
      </Band>

      <Band
        id="walkthrough"
        kicker="How it fits together"
        title="Every app does the same five things."
        intro={
          <p>
            Start a space, describe its data, say who may do what, use it, and read what it shows or proves.
            Pick a community to see them in its terms. Each one runs, step by step, as a test in the
            repository.
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
                They're ordinary collections. When two apps use the same one, a poll made in one can be voted
                on in the other. You can always define your own.
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
                You describe each operation once, with a name, a sentence and a JSON Schema, and it becomes a
                CLI command, an MCP tool and a WebMCP tool in the browser.
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
            Other open protocols give people their data back too. Here’s how they differ. Minca is for apps
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
          <h2>Build your first app.</h2>
          <p>Connect to your users' accounts, open a space, read and write. One short guide.</p>
          <div className="actions">
            <a href={`${DOCS}/building-an-app.md`} data-intent="primary" {...EXTERNAL}>
              Read the guide
            </a>
            <Link to="/protocol" data-intent="secondary">
              How it works
            </Link>
          </div>
        </div>
      </section>
    </Page>
  );
}
