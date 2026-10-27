import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { offeredActions, type NodeAction } from '@minca/core';
import { Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import { type ShapeColour } from '@minca/ui/tokens';
import { Band, Code, CopyButton, Page, Tabs } from './Site';

/**
 * Connecting an AI to your spaces over MCP: one `minca connect` command, which
 * opens the account home to allow it, then the agent starts `minca mcp` by
 * itself (packages/cli/README.md, Agents). Laid out as a reference: set up by
 * client, every tool the agent gets, then questions.
 */

/** What people run on the computer their AI runs on */
const COMMAND = 'npx @minca/cli connect';
/** What an AI app starts, for those who add Minca by hand */
const SERVER = ['-y', '@minca/cli@latest', 'mcp'];
const SERVER_JSON = JSON.stringify({ mcpServers: { minca: { command: 'npx', args: SERVER } } }, null, 2);

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

/** Setting Minca up in each AI app: the command does every app it finds, the rest is by hand */
const CLIENTS: ReadonlyArray<{
  id: string;
  name: string;
  shape?: { kind: ShapeKind; colour: ShapeColour };
  how: ReactNode;
  file?: string;
  code: string;
}> = [
  {
    id: 'any',
    name: 'Every app at once',
    shape: { kind: 'sparkle', colour: 'peach' },
    how: (
      <>
        Run this on the computer your AI runs on. Your account home opens so you can allow it, then it adds
        itself to every AI app it finds there.
      </>
    ),
    code: COMMAND,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    how: 'Add it from a terminal.',
    code: `claude mcp add minca -- npx ${SERVER.join(' ')}`,
  },
  {
    id: 'codex',
    name: 'Codex',
    how: 'Add it from a terminal.',
    code: `codex mcp add minca -- npx ${SERVER.join(' ')}`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    how: 'Put this in your Cursor MCP settings.',
    file: '~/.cursor/mcp.json',
    code: SERVER_JSON,
  },
  {
    id: 'vscode',
    name: 'VS Code',
    how: 'Add it from a terminal.',
    code: `code --add-mcp '${JSON.stringify({ name: 'minca', command: 'npx', args: SERVER })}'`,
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    how: 'In Settings, open Developer and Edit Config, and put this in the file.',
    file: 'claude_desktop_config.json',
    code: SERVER_JSON,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    how: 'Put this in your Gemini settings.',
    file: '~/.gemini/settings.json',
    code: SERVER_JSON,
  },
  {
    id: 'other',
    name: 'Other apps',
    how: 'Most apps that speak MCP take a server in this shape.',
    code: SERVER_JSON,
  },
];

function Clients() {
  const [selected, setSelected] = useState(CLIENTS[0]?.id ?? '');
  return (
    <Tabs label="AI apps" items={CLIENTS} selected={selected} onSelect={setSelected}>
      {(client) => (
        <div className="concept">
          <div>
            <h3>{client.name}</h3>
            <p>{client.how}</p>
            {client.id !== 'any' && (
              <p>
                Then ask your AI to connect to Minca. It opens your account home for you to allow it, and asks
                for the six digits shown there.
              </p>
            )}
          </div>
          <Code file={client.file} lang={client.code.startsWith('{') ? 'typescript' : 'shell'} copy>
            {client.code}
          </Code>
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
    a: 'Everything in the spaces you’re in, the way you see it. Your account’s keys stay at your account home.',
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
    a: (
      <>
        30 days. Then run <code>{COMMAND}</code> again.
      </>
    ),
  },
  {
    q: 'How do I disconnect it?',
    a: (
      <>
        From your account home, which stops it everywhere. Or run <code>npx @minca/cli disconnect</code> on
        that computer.
      </>
    ),
  },
  {
    q: 'Which AI apps work?',
    a: 'Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, and most others that speak MCP.',
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
    a: 'Type its address when the command asks. Everyone else presses Enter for home.minca.social.',
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
                Connect Claude, Cursor or any AI that speaks MCP to your spaces. Ask it what’s happening at
                the club, or tell it to take the last seat.
              </p>
              <div className="command">
                <code>{COMMAND}</code>
                <CopyButton text={COMMAND} />
              </div>
              <div className="actions">
                <a href="#clients" className="btn btn-primary btn-lg">
                  Set it up ↘
                </a>
                <a href="#tools" className="btn btn-secondary btn-lg">
                  See the tools ↘
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
        intro={<p>The command sets up every app it finds. Or add Minca to one by hand.</p>}
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
