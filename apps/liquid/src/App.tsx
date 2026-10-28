import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useConnection, useNode, useSpaces } from '@minca/react';
import { Loader } from '@minca/app-shared/Loader';
import { styles, palette } from '@minca/app-shared/styles';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { AssemblySpace } from './Assembly';
import { isAssembly, prepareAssembly } from './setup';

/**
 * Liquid on its own: connect an account, pick one of the spaces given to it,
 * and that space is an assembly. Everything else is the assembly itself.
 */
export function App() {
  const { state } = useConnection();
  if (state.status !== 'ready') return <Connect />;
  return <Spaces />;
}

/** Before Liquid is connected: one button that opens the account home, where the person chooses spaces */
function Connect() {
  const { connection, state } = useConnection();
  const waiting = state.status === 'connecting' || state.status === 'starting';
  return (
    <div className="page">
      <div style={styles.card}>
        <div style={{ marginBottom: 40 }}>
          <Wordmark compact />
        </div>
        <h1 style={styles.title}>Liquid</h1>
        <p style={styles.subtitle}>
          Vote on proposals yourself, or trust someone to vote for you, topic by topic. Connect your Minca
          account, and choose the space your group decides in.
        </p>
        <button
          onClick={() => void connection.connect()}
          disabled={waiting}
          data-variant="primary"
          style={styles.button}
        >
          {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect with Minca'}
        </button>
        {state.error && <p style={styles.error}>{state.error}</p>}
      </div>
    </div>
  );
}

/** The spaces Liquid was given; one of them open as an assembly */
function Spaces() {
  const { spaces, loading } = useSpaces();
  const { connection } = useConnection();
  const [open, setOpen] = useState<string | null>(null);
  const space = spaces.find((one) => one.id === open) ?? (spaces.length === 1 ? spaces[0] : undefined);
  if (loading) return <Loader />;
  if (space)
    return <Assembly key={space.id} space={space} onBack={spaces.length > 1 ? () => setOpen(null) : null} />;
  return (
    <div className="page">
      <div style={styles.card}>
        <h1 style={styles.title}>Which space decides?</h1>
        {spaces.length === 0 ? (
          <p style={styles.subtitle}>
            Liquid has no spaces yet. Connect again, and give it one at your account home.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, padding: 0 }}>
            {spaces.map((one) => (
              <li key={one.id}>
                <button
                  onClick={() => setOpen(one.id)}
                  data-variant="quiet"
                  style={{ ...styles.button, width: '100%' }}
                >
                  {one.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={() => void connection.connect()} data-variant="quiet" style={styles.smallButton}>
          Choose other spaces
        </button>
      </div>
    </div>
  );
}

/** A space as an assembly, once it is one: made one here when this account may */
function Assembly({ space, onBack }: { space: SpaceSummary; onBack: (() => void) | null }) {
  const node = useNode();
  const [ready, setReady] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!(await isAssembly(node, space.id))) await prepareAssembly(node, space.id);
      return isAssembly(node, space.id);
    })().then(
      (is) => live && setReady(is),
      (error: unknown) => {
        if (!live) return;
        setReady(false);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [node, space.id]);

  if (ready === null) return <Loader />;
  if (!ready)
    return (
      <div className="page">
        <div style={styles.card}>
          <h1 style={styles.title}>{space.name} isn't an assembly yet</h1>
          <p style={styles.subtitle}>
            Someone whose role lets them add collections there opens it in Liquid first, and then it is one
            for everyone.
          </p>
          {problem && <p style={{ fontSize: 13, color: palette.ink.faint }}>{problem}</p>}
          {onBack && (
            <button onClick={onBack} data-variant="quiet" style={styles.smallButton}>
              Another space
            </button>
          )}
        </div>
      </div>
    );
  return (
    <div className="page">
      {onBack && (
        <button onClick={onBack} data-variant="ghost" style={styles.linkButton}>
          ← Spaces
        </button>
      )}
      <AssemblySpace space={space} />
    </div>
  );
}
