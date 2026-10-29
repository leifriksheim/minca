import { useState, type ReactNode } from 'react';
import { Modal } from '@minca/app-shared/Modal';
import { useCopy } from '@minca/app-shared/action';
import { styles, palette, hstack } from '../styles';
import { LinkButton, PrimaryButton } from './Buttons';

/** What people run: it opens their account home, where they allow it */
const COMMAND = import.meta.env.VITE_MINCA_CONNECT ?? 'npx @minca/cli connect';

/** The step after connecting, when the agent is connected for something */
interface AfterConnecting {
  readonly title: string;
  readonly body: ReactNode;
}

/**
 * How to connect an agent on a computer, as numbered steps: one command to
 * paste, which opens the account home to allow it. The app is not part of
 * it; it only says how. A `then` step says what to do next; without one, it
 * is starting a new session.
 */
export function ConnectAgent({
  onClose,
  title = 'Connect an agent',
  then,
}: {
  onClose: () => void;
  title?: string;
  then?: AfterConnecting;
}) {
  const { copied, copy } = useCopy();
  // Someone whose agent is already connected goes straight to what comes next.
  const [skipped, setSkipped] = useState(false);
  const at = skipped ? 'done' : 'now';

  return (
    <Modal title={title} onClose={onClose} width={500}>
      <p style={{ ...styles.hint, marginBottom: 0 }}>
        Works with Claude Code, Claude Desktop, Cursor, VS Code and other agents. It takes about a minute.
      </p>

      <ol style={stepList}>
        <AgentStep
          n={1}
          title="Paste this in a terminal"
          at={at}
          aside={
            skipped ? null : (
              <LinkButton type="button" onClick={() => setSkipped(true)} style={{ fontSize: 13, padding: 0 }}>
                Already connected
              </LinkButton>
            )
          }
        >
          <p style={stepText}>
            On the computer your agent runs on: Terminal on a Mac, PowerShell on Windows. It finds the agents
            installed there.
          </p>
          <div style={commandBox}>
            <code style={commandText}>{COMMAND}</code>
            <PrimaryButton
              onClick={() => copy(COMMAND)}
              style={{ width: 'auto', height: 32, padding: '0 14px', fontSize: 13 }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </PrimaryButton>
          </div>
        </AgentStep>

        <AgentStep n={2} title="Allow it at your account home" at={at}>
          <p style={stepText}>
            It opens in your browser. Allow it there, then type the six-digit code it shows into the terminal.
            Your agent may read the spaces in your account and write records in them, marked “via agent”. It
            can’t add apps, change who may do what, or open your contact requests.
          </p>
        </AgentStep>

        <AgentStep n={3} title={then?.title ?? 'Start a new session'} at="now" last>
          {then ? (
            then.body
          ) : (
            <>
              <p style={stepText}>
                Start a new session in your agent, or restart it, and it can work in your spaces, even with
                this tab closed. You can disconnect it any time in your account settings.
              </p>
              <PrimaryButton
                onClick={onClose}
                style={{ alignSelf: 'flex-start', width: 'auto', padding: '0 20px' }}
              >
                Done
              </PrimaryButton>
            </>
          )}
        </AgentStep>
      </ol>
    </Modal>
  );
}

/**
 * One numbered step of a guide: done ones are ticked and short, the one to do
 * now is open, and those after it wait greyed out.
 */
function AgentStep({
  n,
  title,
  at,
  last,
  aside,
  children,
}: {
  n: number;
  title: string;
  at: 'done' | 'now' | 'later';
  last?: boolean;
  /** Beside the title, such as a way to do a done step again */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li style={hstack(14)} aria-current={at === 'now' ? 'step' : undefined}>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <span style={marker[at]}>{at === 'done' ? '✓' : n}</span>
        {!last && <span style={{ flex: 1, width: 1.5, minHeight: 16, background: palette.surface.line }} />}
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingBottom: last ? 0 : 22,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <p
            style={{
              fontSize: 15,
              lineHeight: '28px',
              fontWeight: 600,
              color: at === 'later' ? palette.ink.faint : palette.ink.strong,
            }}
          >
            {title}
          </p>
          {aside}
        </div>
        {at === 'now' && children}
      </div>
    </li>
  );
}

/** A list of steps, for `AgentStep` */
const stepList = {
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  marginTop: 6,
} as const;
export const stepText = { fontSize: 13.5, lineHeight: 1.55, color: palette.ink.body } as const;

const circle = {
  width: 28,
  height: 28,
  borderRadius: palette.radius.pill,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  fontWeight: 600,
  flexShrink: 0,
} as const;
const marker = {
  done: { ...circle, background: palette.accent.goodSoft, color: palette.accent.good },
  now: { ...circle, background: palette.accent.base, color: palette.ink.inverse },
  later: { ...circle, border: `1.5px solid ${palette.surface.line}`, color: palette.ink.faint },
} as const;

const commandBox = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 8px 8px 14px',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  fontFamily: palette.mono,
} as const;
const commandText = {
  flex: 1,
  minWidth: 0,
  overflowWrap: 'anywhere',
  fontSize: 12.5,
  lineHeight: 1.5,
  color: palette.ink.strong,
} as const;
