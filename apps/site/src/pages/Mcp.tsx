import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { offeredActions, type NodeAction } from '@minca/core';
import { Shape } from '@minca/app-shared/shapes';
import { MCP_URL, addToClaude, addToCursor } from '@minca/app-shared/mcp';
import { AppLogo, type AppLogoName } from '@minca/app-shared/AppLogo';
import { Terminal } from '@minca/app-shared/Terminal';
import { type ShapeKind } from '@minca/ui/shapes';
import { Band, Page, Tabs } from './Site';
import './Mcp.css';

/**
 * Connecting an AI to your spaces over MCP. Most apps connect to Minca's MCP
 * service by its address (packages/cli/README.md, `minca mcp-server`), in one
 * click where the app has an install link (`@minca/app-shared/mcp`). On your
 * own computer, `minca connect` runs `minca mcp` instead. Laid out as a
 * reference: set up by app, every tool the agent gets, then questions.
 */

/** What people run to keep Minca on their own computer instead */
const COMMAND = 'npx @minca/cli connect';

/** A chat with a connected agent, as a chat app would show it */
const CHAT: ReadonlyArray<{ from: 'you' | 'ai'; text: ReactNode }> = [
  { from: 'you', text: 'What’s happening at the club this week?' },
  {
    from: 'ai',
    text: 'Saturday’s away game has two cars and one seat left. Anna asked who can bring oranges.',
  },
  { from: 'you', text: 'Take the seat, and put me down for oranges.' },
  {
    from: 'ai',
    text: (
      <>
        Done. You’re in Joe’s car, and the oranges are yours.
        <span className="chat-via">Shows in Minca as you, via agent</span>
      </>
    ),
  },
];

function Chat() {
  return (
    <div className="chat-mock" aria-hidden>
      {CHAT.map((line, i) => (
        <div key={i} className={`chat-line chat-${line.from}`}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

/** What happens once an app is pointed at the service */
const SIGN_IN =
  'Your account home opens. Pick the spaces your AI may use and allow it, and you’re back in the chat.';

/** Setting Minca up in each AI app: a button where the app has an install link, else a line to paste */
const CLIENTS: ReadonlyArray<{
  id: string;
  name: string;
  logo: AppLogoName;
  how: ReactNode;
  link?: { href: string; label: string };
  code?: string;
  then?: ReactNode;
}> = [
  {
    id: 'claude',
    name: 'Claude',
    logo: 'claude',
    how: 'Add it once and it’s there on claude.ai, in the desktop app and on your phone.',
    link: { href: addToClaude(), label: 'Add to Claude ↗' },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    logo: 'openai',
    how: 'In Settings, open Apps & Connectors, then Advanced, and turn on Developer mode. Then create a connector and paste this address.',
    code: MCP_URL,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    logo: 'cursor',
    how: 'Cursor opens and asks you to install it.',
    link: { href: addToCursor(), label: 'Add to Cursor ↗' },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    logo: 'claude',
    how: 'Add it from a terminal, then run /mcp in Claude Code to sign in.',
    code: `claude mcp add --transport http minca ${MCP_URL}`,
  },
  {
    id: 'codex',
    name: 'Codex',
    logo: 'openai',
    how: 'Add it from a terminal.',
    code: `codex mcp add minca --url ${MCP_URL}`,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    logo: 'gemini',
    how: 'Add it from a terminal.',
    code: `gemini mcp add --transport http minca ${MCP_URL}`,
  },
  {
    id: 'other',
    name: 'Other apps',
    logo: 'mcp',
    how: 'Any app that takes a remote MCP server takes this address.',
    code: MCP_URL,
  },
  {
    id: 'computer',
    name: 'On your computer',
    logo: 'terminal',
    how: 'Rather keep it on your own machine? Run this there. It adds Minca to every AI app it finds, for all your spaces.',
    code: COMMAND,
    then: 'Your account home opens so you can allow it, and shows six digits to type into the terminal.',
  },
];

function Clients() {
  const [selected, setSelected] = useState(CLIENTS[0]?.id ?? '');
  const tabs = CLIENTS.map((client) => ({ ...client, icon: <AppLogo name={client.logo} size={18} /> }));
  return (
    <Tabs label="AI apps" items={tabs} selected={selected} onSelect={setSelected}>
      {(client) => (
        <div className="client">
          <h3>{client.name}</h3>
          <p>{client.how}</p>
          {client.link ? (
            <a href={client.link.href} data-intent="primary" target="_blank" rel="noreferrer">
              {client.link.label}
            </a>
          ) : (
            client.code && <Terminal text={client.code} />
          )}
          <p className="client-then">{client.then ?? SIGN_IN}</p>
        </div>
      )}
    </Tabs>
  );
}

/** The tools as a person would say them; a tool missing here shows its own description's first sentence */
const SAYS: Readonly<Record<string, string>> = {
  node_info: 'Who it’s acting for.',
  spaces_list: 'The spaces you’re in.',
  spaces_preview_invite: 'What an invite offers, without joining.',
  spaces_access: 'Who’s allowed to do what in a space.',
  spaces_status: 'Who’s online, and whether it’s caught up.',
  spaces_profiles: 'The names people go by in a space.',
  collections_list: 'What a space keeps, like events, lists and expenses.',
  collections_standard: 'The kinds of things every Minca app understands.',
  collections_propose: 'Suggest a new tool for the group. Someone who’s allowed adds it.',
  collections_proposals: 'The tools people have suggested.',
  records_list: 'Everything in a collection.',
  records_query: 'Find things, like open jobs or this week’s games.',
  records_get: 'Read one thing.',
  records_history: 'Earlier versions of something.',
  records_put: 'Add something, like an event or a reply.',
  records_linked: 'The comments, reactions and votes on something.',
  records_can: 'Check it’s allowed before trying.',
  records_update: 'Change something.',
  records_delete: 'Delete something for everyone in the space.',
  activity_set: 'Show what it’s working on, like “Reading the thread”.',
};

const GROUPS: ReadonlyArray<{
  title: string;
  intro: string;
  shape: ShapeKind;
  colour: string;
  has: (name: string) => boolean;
}> = [
  {
    title: 'Spaces',
    intro: 'Finding its way around.',
    shape: 'group',
    colour: 'c-cobalt',
    has: (name) => name === 'node_info' || name.startsWith('spaces_'),
  },
  {
    title: 'Collections',
    intro: 'The kinds of things a space keeps.',
    shape: 'stack',
    colour: 'c-sage',
    has: (name) => name.startsWith('collections_'),
  },
  {
    title: 'Records',
    intro: 'The things themselves.',
    shape: 'flower',
    colour: 'c-coral',
    has: () => true,
  },
];

const said = (action: NodeAction) => SAYS[action.name] ?? `${action.description.split('. ')[0]}.`;
const kind = (action: NodeAction) => (action.readOnly ? 'Reads' : action.destructive ? 'Changes' : 'Writes');

/** Each tool an agent is offered, in the first group that has it */
const TOOL_GROUPS = GROUPS.map((group, i) => ({
  ...group,
  tools: offeredActions({ agent: true }).filter(
    (action) => GROUPS.findIndex((each) => each.has(action.name)) === i,
  ),
}));

function Tools() {
  const groups = TOOL_GROUPS;
  return (
    <div className="tool-groups">
      {groups.map((group) => (
        <div key={group.title} className="split">
          <div className="tool-group-head">
            <Shape kind={group.shape} className={group.colour} />
            <h3>
              {group.title} <span>{group.tools.length}</span>
            </h3>
            <p>{group.intro}</p>
          </div>
          <ul className="tool-list">
            {group.tools.map((action) => (
              <li key={action.name}>
                <code>{action.name}</code>
                <span className={`tool-kind tool-${kind(action).toLowerCase()}`}>{kind(action)}</span>
                <p>{said(action)}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const QUESTIONS: ReadonlyArray<{ q: string; a: ReactNode }> = [
  {
    q: 'What can my AI see?',
    a: 'Only the spaces you pick when you connect it, the way you see them. Your account’s keys stay at your account home.',
  },
  {
    q: 'What can’t it do?',
    a: 'It can’t change who’s in a space or what they’re allowed to do. It can’t add new kinds of things either. It suggests them, and someone who’s allowed adds them.',
  },
  {
    q: 'Will people know my AI did it?',
    a: 'Yes. What it writes shows as you, marked “via agent”.',
  },
  {
    q: 'How long does it stay connected?',
    a: '30 days. Then your AI asks you to sign in again.',
  },
  {
    q: 'How do I disconnect it?',
    a: 'From your account home, where it shows as a connection. That stops it everywhere at once.',
  },
  {
    q: 'Which AI apps work?',
    a: 'Claude, ChatGPT, Cursor, Claude Code, Codex, Gemini CLI, and most others that take a remote MCP server.',
  },
  {
    q: 'Who runs the server my AI talks to?',
    a: (
      <>
        We do, at <code>mcp.minca.social</code>. It holds your spaces in memory while your AI is working and
        forgets them after ten quiet minutes. Rather keep it on your own computer? Run <code>{COMMAND}</code>{' '}
        there.
      </>
    ),
  },
  {
    q: 'I don’t use a chat app. Can I still use it?',
    a: (
      <>
        Run <code>npx @minca/cli agent</code> and talk to it in the terminal, with your own Anthropic key. It
        stops for the day once it has spent what you allowed.
      </>
    ),
  },
  {
    q: 'I run my own account home.',
    a: 'Type its address when the sign-in asks. Everyone else goes on to home.minca.social.',
  },
  {
    q: 'I’m building something with it.',
    a: (
      <>
        Every tool is a plain JSON action. <Link to="/developers">The developer guide</Link> has the details.
      </>
    ),
  },
];

export function Mcp() {
  return (
    <Page page="mcp">
      <section className="band ext-hero">
        <div className="wrap">
          <div className="tile tile-panel extension c-lilac">
            <div>
              <div className="kicker-inline">MCP</div>
              <h1>Bring your own AI.</h1>
              <p>
                Connect Claude, ChatGPT or any AI that speaks MCP to your spaces. Ask it what’s happening at
                the club, or tell it to take the last seat.
              </p>
              <div className="mcp-url">
                <Terminal text={MCP_URL} />
              </div>
              <div className="actions">
                <a href={addToClaude()} data-intent="primary" target="_blank" rel="noreferrer">
                  Add to Claude ↗
                </a>
                <a href="#clients" data-intent="secondary">
                  Other AI apps ↘
                </a>
              </div>
            </div>
            <Chat />
          </div>
        </div>
      </section>

      <Band
        id="clients"
        title="Choose your AI app."
        intro={<p>One click where your app has a button. Everywhere else, paste the address.</p>}
      >
        <Clients />
      </Band>

      <Band
        id="tools"
        tone="sunken"
        title="Tools"
        intro={
          <p>What your AI can do in your spaces. It can’t add people or change who’s allowed to do what.</p>
        }
      >
        <Tools />
      </Band>

      <Band id="faq" title="Questions">
        <div className="faq">
          {QUESTIONS.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </Band>
    </Page>
  );
}
