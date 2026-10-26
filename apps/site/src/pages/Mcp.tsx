import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import { Band, Marked, Page } from './Site';

/**
 * Connecting an AI to your spaces over MCP: one `minca connect` command, which
 * opens the account home to allow it, then the agent starts `minca mcp` by
 * itself (packages/cli/README.md, Agents).
 */

/** What people run on the computer their AI runs on */
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

const STEPS: ReadonlyArray<{ colour: string; shape: ShapeKind; title: string; body: ReactNode }> = [
  {
    colour: 'c-peach',
    shape: 'flower',
    title: 'Run one command',
    body: (
      <>
        Paste <code>{COMMAND}</code> into a terminal on the computer your AI runs on.
      </>
    ),
  },
  {
    colour: 'c-sage',
    shape: 'clover',
    title: 'Say yes',
    body: <>Your account home opens in the browser. Sign in, or make an account, and allow it.</>,
  },
  {
    colour: 'c-lilac',
    shape: 'burst',
    title: 'Start a chat',
    body: <>It adds itself to the AI apps it finds. Start a new chat and ask away.</>,
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
                Connect Claude, Cursor or any AI that speaks MCP to your spaces. It knows what’s going on,
                gets things done for you, and builds the tools your group asks for.
              </p>
              <div className="actions">
                <a href="#connect" className="btn btn-primary btn-lg">
                  Connect your AI
                </a>
              </div>
            </div>
            <Chat />
          </div>
        </div>
      </section>

      <Band
        title="Use the AI you already like."
        intro={<p>Minca doesn’t sell you one. Pick whichever you trust, and switch whenever you like.</p>}
      >
        <Marked
          columns={3}
          items={[
            {
              title: 'Ask about anything',
              body: 'What’s on, who’s coming, what still needs doing. It reads your spaces the way you can.',
              shape: 'eyeShut',
            },
            {
              title: 'Get it done',
              body: 'It adds the event, takes the seat, ticks the job off. Everyone sees it came via agent.',
              shape: 'tick',
            },
            {
              title: 'Build new tools',
              body: 'It proposes the tool your group asked for, and someone who’s allowed adds it.',
              shape: 'sparkle',
            },
            {
              title: 'Only what you allow',
              body: 'It writes records and nothing else. It can’t invite people, change roles, or join and leave spaces.',
              shape: 'lock',
            },
            {
              title: 'A month at a time',
              body: 'It lasts 30 days, then asks again. Disconnect it from your account home whenever you like.',
              shape: 'signal',
            },
            {
              title: 'Works with most AI apps',
              body: 'Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI and more.',
              shape: 'group',
            },
          ]}
        />
      </Band>

      <Band id="connect" tone="sunken" title="Three steps, about a minute.">
        <div className="tiles">
          {STEPS.map((step, i) => (
            <div key={step.title} className={`tile ${step.colour}`}>
              <Shape kind={step.shape} className="tile-art" />
              <div className="tile-num">{i + 1}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
        <div className="split" style={{ marginTop: 72 }}>
          <div>
            <h3 className="split-title">Good to know</h3>
          </div>
          <div>
            <p>
              Added Minca to your AI by hand? Ask it to connect, and it opens your account home the same way.
            </p>
            <p>
              Run your own account home? Type its address when the command asks. Everyone else just presses
              Enter for home.minca.social.
            </p>
            <p>
              No chat app? Run <code>npx @minca/cli agent</code> and talk to it right in the terminal, with
              your own Anthropic key. It stops for the day once it has spent what you allowed.
            </p>
            <p>
              Building something with it? Every tool it gets is a plain JSON action.{' '}
              <Link to="/developers">The developer guide</Link> has the list.
            </p>
          </div>
        </div>
      </Band>
    </Page>
  );
}
