import type { ReactNode } from 'react';
import type { AuthError } from '@minca/auth';
import { useAuth } from '@minca/react';

/* What every sign-in screen is made of, on the design system's own elements. */

/** One screen of the flow: its title, the line under it, and the rest */
export function Step({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h1>{title}</h1>
      {lead && <p>{lead}</p>}
      {children}
    </section>
  );
}

/** What went wrong, and what to try */
export function Problem({ error }: { error: AuthError | null }) {
  if (!error) return null;
  return (
    <p role="alert">
      {error.message}
      {error.hint && <small> {error.hint}</small>}
    </p>
  );
}

/** A lesser way on from a screen (Back, another way in), in a row of them; `inline`, a word in a sentence */
export function Way({
  onClick,
  inline = false,
  children,
}: {
  onClick: () => unknown;
  inline?: boolean;
  children: ReactNode;
}) {
  const { state } = useAuth();
  return (
    <button onClick={() => void onClick()} disabled={state.busy} data-intent={inline ? 'inline' : 'ghost'}>
      {children}
    </button>
  );
}
