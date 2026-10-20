import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { MincaAuth as Auth, MincaSession } from '../session/auth.js';
import '../elements/minca-auth.js';
import { useMinca } from './context.js';
import type { MincaAuthElement } from '../elements/minca-auth.js';

export interface MincaAuthProps {
  /** The flow to draw. Default: the one from the nearest `MincaProvider`. */
  readonly auth?: Auth;
  /** Someone signed in (a session) or out (null) */
  readonly onSession?: (session: MincaSession | null) => void;
  /** Draws an account's avatar, so the element shows accounts as the rest of the page does */
  readonly avatar?: (did: string, size: number, round: boolean) => Element;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The `<minca-auth>` element, for React. Fits whatever it is put in — a page,
 * a modal, a panel — and draws nothing once someone is signed in.
 */
export function MincaAuth({
  auth: given,
  onSession,
  avatar,
  className,
  style,
}: MincaAuthProps): ReactElement {
  const fromProvider = useMinca().auth;
  const auth = given ?? fromProvider;
  if (!auth) throw new Error('<MincaAuth> needs an auth prop, or a MincaProvider with one.');
  const [element, setElement] = useState<MincaAuthElement | null>(null);

  // Sets the flow before the element connects, so it draws this one rather
  // than making one of its own from attributes; and again when it changes.
  const attach = useCallback(
    (attached: MincaAuthElement | null) => {
      if (attached) {
        attached.auth = auth;
        attached.avatar = avatar ?? null;
      }
      setElement(attached);
    },
    [auth, avatar],
  );

  useEffect(() => {
    if (!element || !onSession) return;
    const listener = (event: CustomEvent<{ session: MincaSession | null }>) =>
      onSession(event.detail.session);
    element.addEventListener('minca-session', listener);
    return () => element.removeEventListener('minca-session', listener);
  }, [element, onSession]);

  return createElement('minca-auth', {
    ref: attach,
    ...(className ? { class: className } : {}),
    ...(style ? { style } : {}),
  });
}
