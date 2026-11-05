import type { ReactNode } from 'react';
import type { AuthError } from '@minca/core/session';
import { useAuth } from '@minca/react';
import { Shape } from '@minca/app-shared/shapes';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';

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

/** One choice in a list of them (`<ul role="list">`), marked with its shape */
export function Choice({
  shape: [kind, colour],
  title,
  text,
  onClick,
  recommended = false,
}: {
  shape: readonly [ShapeKind, ShapeColour];
  title: string;
  text: string;
  onClick: () => unknown;
  recommended?: boolean;
}) {
  const { state } = useAuth();
  return (
    <li>
      <button onClick={() => void onClick()} disabled={state.busy} data-intent="open" className="row">
        <Shape kind={kind} colour={colour} size={32} />
        <span className="stack" data-gap="tight">
          <strong className="row">
            {title}
            {recommended && <span className="tag">Recommended</span>}
          </strong>
          <small>{text}</small>
        </span>
      </button>
    </li>
  );
}

/** A lesser way on from a screen (Back, another way in), in a row of them */
export function Way({ onClick, children }: { onClick: () => unknown; children: ReactNode }) {
  const { state } = useAuth();
  return (
    <button onClick={() => void onClick()} disabled={state.busy} data-intent="ghost">
      {children}
    </button>
  );
}
