import { useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAsync, useConnection, useNode, useSpaces } from '@minca/react';
import { Loader } from '@minca/app-shared/Loader';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { AssemblySpace } from './Assembly';
import { becomeAssembly } from './setup';
import styles from './App.module.css';

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
    <main className={styles.narrow}>
      <Wordmark compact />
      <div className="stack">
        <h1>Liquid</h1>
        <p>
          Vote on proposals yourself, or trust someone to vote for you, topic by topic. Connect your Minca
          account, and choose the space your group decides in.
        </p>
      </div>
      <button onClick={() => void connection.connect()} disabled={waiting} data-intent="primary">
        {state.status === 'connecting' ? 'Waiting for your account home…' : 'Continue with Minca'}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
    </main>
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
    <main className={styles.narrow}>
      <h1>Which space decides?</h1>
      {spaces.length === 0 ? (
        <p>Liquid has no spaces yet. Connect again, and give it one at your account home.</p>
      ) : (
        <ul role="list">
          {spaces.map((one) => (
            <li key={one.id}>
              <button onClick={() => setOpen(one.id)} data-intent="open">
                {one.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => void connection.connect()} data-intent="ghost">
        Choose other spaces
      </button>
    </main>
  );
}

/** A space as an assembly, once it is one: made one here when this account may */
function Assembly({ space, onBack }: { space: SpaceSummary; onBack: (() => void) | null }) {
  const node = useNode();
  const assembly = useAsync(() => becomeAssembly(node, space.id), [node, space.id]);

  if (assembly.status === 'loading') return <Loader />;
  if (assembly.status === 'failed' || !assembly.value)
    return (
      <main className={styles.narrow}>
        <div className="stack">
          <h1>{space.name} isn't an assembly yet</h1>
          <p>
            Someone whose role lets them add collections there opens it in Liquid first, and then it is one
            for everyone.
          </p>
          {assembly.status === 'failed' && <small>{assembly.error.message}</small>}
        </div>
        {onBack && (
          <button onClick={onBack} data-intent="ghost">
            Another space
          </button>
        )}
      </main>
    );
  return (
    <main className={styles.wide}>
      {onBack && (
        <button onClick={onBack} data-intent="ghost">
          ← Spaces
        </button>
      )}
      <AssemblySpace space={space} />
    </main>
  );
}
