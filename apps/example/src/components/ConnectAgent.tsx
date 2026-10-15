import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { connectToHome, offerConnectCode, type CodeAsking, type ConnectCodeStage } from '@minca/core/session';
import { useAccount, useConnection } from '@minca/core/react';
import { Choice, Modal } from '@minca/app-shared/Modal';
import { relayUrls } from '@minca/app-shared/relay';
import { message, useAction, useCopy } from '@minca/app-shared/action';
import { Loader } from '@minca/app-shared/Loader';
import { styles, palette, variants } from '../styles';
import { programRequest } from '../program-terms';

/** What people run, before the code */
const COMMAND = import.meta.env.VITE_MINCA_CONNECT ?? 'npx @minca/cli connect';
/** The relay the CLI meets on unless told otherwise (`packages/cli/src/agent.ts`) */
const CLI_RELAY = 'wss://minca.fly.dev';

const LASTS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '1 week' },
  { value: '30', label: '30 days' },
  { value: '365', label: '1 year' },
] as const;
type Lasts = (typeof LASTS)[number]['value'];

type Step =
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'asking'; readonly stage: Extract<ConnectCodeStage, { kind: 'asking' }> }
  | { readonly kind: 'connected'; readonly agent: CodeAsking }
  | { readonly kind: 'failed'; readonly reason: string };

/** The step after connecting, when the agent is connected for something */
export interface AfterConnecting {
  readonly title: string;
  readonly body: (agent: string) => ReactNode;
}

/**
 * Connects an agent on this computer, as numbered steps: one command to paste,
 * then allowing it here, where the account home signs its note. A `then` step
 * says what to do with it next; without one, it is starting a new session.
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
  const { state } = useConnection();
  const { did } = useAccount();
  const [days, setDays] = useState<Lasts>('30');
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const [code, setCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { copied, copy } = useCopy();
  const { run, busy, error } = useAction();
  const connectedName = step.kind === 'connected' ? step.agent.name : null;
  useEffect(() => {
    if (connectedName) rememberAgent(did, connectedName, Number(days));
  }, [did, connectedName, days]);

  useEffect(() => {
    let stopped = false;
    let refused = false;
    let stop = () => {};
    void offerConnectCode({ relays: relayUrls(), account: did }, (stage) => {
      if (stopped) return;
      // This app gives a program records only, whatever it asks for: its ask is a request, the terms are ours.
      if (stage.kind === 'asking' && !programRequest(stage.asking, 1)) {
        refused = true;
        stage.deny('This app connects a program for records only. Ask for records only.');
        setStep({
          kind: 'failed',
          reason: `“${stage.asking.name}” asked for more than records, which this app doesn't give. Make a new code to try again.`,
        });
        return;
      }
      if (refused) return;
      setStep(
        stage.kind === 'asking'
          ? { kind: 'asking', stage }
          : stage.kind === 'connected'
            ? { kind: 'connected', agent: stage.asking }
            : stage,
      );
    }).then(
      (offer) => {
        if (stopped) return offer.stop();
        stop = () => offer.stop();
        setCode(offer.code);
      },
      (e: unknown) => !stopped && setStep({ kind: 'failed', reason: message(e) }),
    );
    return () => {
      stopped = true;
      stop();
    };
  }, [attempt, did]);

  const relays = relayUrls();
  const command = code
    ? `${COMMAND} ${code}${relays.includes(CLI_RELAY) || !relays[0] ? '' : ` --relay ${relays[0]}`}`
    : '';

  // From the click itself: the home opens in a popup.
  const allow = (stage: Extract<ConnectCodeStage, { kind: 'asking' }>) =>
    run(async () => {
      const request = programRequest(stage.asking, Number(days));
      if (!request) throw new Error('This app connects a program for records only.');
      const grant = await connectToHome({
        home: state.home,
        audience: stage.asking.did,
        audienceProof: stage.asking.proof,
        request,
      });
      await stage.allow(grant);
    });

  const pasting = step.kind === 'starting' || step.kind === 'waiting' || step.kind === 'failed';
  const agent = step.kind === 'asking' ? step.stage.asking.name : connectedName;

  return (
    <Modal title={title} onClose={onClose} width={500}>
      <p style={{ ...styles.hint, marginBottom: 0 }}>
        Works with Claude Code, Claude Desktop, Cursor, VS Code and other agents. It takes about a minute.
      </p>

      <ol style={stepList}>
        <AgentStep
          n={1}
          title={pasting ? 'Paste this in a terminal' : 'Pasted in a terminal'}
          at={pasting ? 'now' : 'done'}
        >
          {step.kind === 'failed' ? (
            <>
              <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{step.reason}</p>
              <button
                onClick={() => {
                  setStep({ kind: 'starting' });
                  setCode(null);
                  setAttempt((n) => n + 1);
                }}
                data-variant="primary"
                style={{ ...styles.button, alignSelf: 'flex-start', width: 'auto', padding: '0 16px' }}
              >
                Make a new code
              </button>
            </>
          ) : (
            <>
              <p style={stepText}>
                On the computer your agent runs on: Terminal on a Mac, PowerShell on Windows. It finds the
                agents installed there.
              </p>
              <div style={commandBox}>
                <code style={commandText}>
                  {command || <Loader size={10} label="Making a code" showLabel />}
                </code>
                <button
                  onClick={() => copy(command)}
                  disabled={!code}
                  data-variant="primary"
                  style={{ ...styles.button, width: 'auto', height: 32, padding: '0 14px', fontSize: 13 }}
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p style={{ ...stepText, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Loader size={10} decorative /> Waiting for your terminal…
              </p>
            </>
          )}
        </AgentStep>

        <AgentStep
          n={2}
          title={
            step.kind === 'connected' ? `${agent} is connected` : agent ? `Allow ${agent}` : 'Allow it here'
          }
          at={step.kind === 'asking' ? 'now' : step.kind === 'connected' ? 'done' : 'later'}
        >
          {step.kind === 'asking' && (
            <>
              <p style={stepText}>
                It may read the spaces in your account and write records in them, marked “via agent”. It can't
                add apps, change who may do what, or open your contact requests. Your account home opens to
                confirm.
              </p>
              <Choice label="For how long" value={days} options={LASTS} onChange={setDays} />
              {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => step.stage.deny()}
                  disabled={busy}
                  data-variant="quiet"
                  style={variants.quiet}
                >
                  Don't allow
                </button>
                <button
                  onClick={() => void allow(step.stage)}
                  disabled={busy}
                  data-variant="primary"
                  style={styles.button}
                >
                  {busy ? 'Waiting for your account home…' : 'Allow'}
                </button>
              </div>
            </>
          )}
        </AgentStep>

        <AgentStep
          n={3}
          title={then?.title ?? 'Start a new session'}
          at={step.kind === 'connected' ? 'now' : 'later'}
          last
        >
          {step.kind === 'connected' &&
            (then ? then.body(step.agent.name) : <Connected agent={step.agent} onClose={onClose} />)}
        </AgentStep>
      </ol>
    </Modal>
  );
}

function Connected({ agent, onClose }: { agent: CodeAsking; onClose: () => void }) {
  return (
    <>
      <p style={stepText}>
        Start a new session in {agent.name}, or restart it, and it can work in your spaces, even with this tab
        closed. You can disconnect it any time in your account settings.
      </p>
      <p style={stepText}>
        To keep it running your automations while this computer is off, connect it on a server the same way
        and run <code>minca agent --no-chat</code> there.
      </p>
      <button
        onClick={onClose}
        data-variant="primary"
        style={{ ...styles.button, alignSelf: 'flex-start', width: 'auto', padding: '0 20px' }}
      >
        Done
      </button>
    </>
  );
}

/**
 * One numbered step of a guide: done ones are ticked and short, the one to do
 * now is open, and those after it wait greyed out.
 */
export function AgentStep({
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
    <li style={{ display: 'flex', gap: 14 }} aria-current={at === 'now' ? 'step' : undefined}>
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
export const stepList = {
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

/** The agent last connected from this browser, by name, until its note runs out: only a hint */
const agentKey = (did: string) => `minca.agent:${did}`;
const agentListeners = new Set<() => void>();
const DAY = 24 * 60 * 60 * 1000;

function rememberAgent(did: string, name: string, days: number) {
  try {
    globalThis.localStorage?.setItem(agentKey(did), JSON.stringify({ name, until: Date.now() + days * DAY }));
  } catch {
    // Not remembered; it asks again next time.
  }
  agentListeners.forEach((listener) => listener());
}

function readAgent(did: string): string | null {
  try {
    const kept: unknown = JSON.parse(globalThis.localStorage?.getItem(agentKey(did)) ?? 'null');
    if (typeof kept !== 'object' || kept === null || !('name' in kept) || !('until' in kept)) return null;
    const { name, until } = kept;
    return typeof name === 'string' && typeof until === 'number' && until > Date.now() ? name : null;
  } catch {
    // Unreadable, or a bare name from before it kept an expiry: not known.
    return null;
  }
}

/** The name of the agent last connected from this browser, while its note lasts */
export function useKnownAgent(): string | null {
  const { did } = useAccount();
  return useSyncExternalStore(
    (listener) => {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    () => readAgent(did),
  );
}
