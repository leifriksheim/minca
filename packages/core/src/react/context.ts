import {
  createContext,
  createElement,
  useContext,
  useEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { AuthState, MincaAuth, MincaSession } from '../session/auth.js';
import type { MincaConnectionState, MincaConnection } from '../session/connection.js';
import type { P2PNode } from '../node/types.js';
import { useFollow, type Followed } from './follow.js';

interface MincaContextValue {
  readonly auth: MincaAuth | null;
  readonly connection: MincaConnection | null;
  readonly node: P2PNode | null;
}

const MincaContext = createContext<MincaContextValue>({ auth: null, connection: null, node: null });

/** A sign-in flow, or a connection: state to follow, once started */
interface Store<S> extends Followed<S> {
  start(): Promise<void>;
}

const nothing = (): null => null;

/** Follows a flow's or a connection's state, and starts it; null when there is none. */
function useStore<S>(store: Store<S> | null): S | null {
  useEffect(() => {
    void store?.start();
  }, [store]);
  return useFollow(store, nothing);
}

export type MincaProviderProps = { readonly children?: ReactNode } &
  /** The account itself, signed in on this site — an account home */
  (
    | { readonly auth: MincaAuth; readonly connection?: undefined; readonly node?: undefined }
    /** An app acting for an account through its home — `createMincaConnection` */
    | { readonly connection: MincaConnection; readonly auth?: undefined; readonly node?: undefined }
    /** A node you started yourself */
    | { readonly node: P2PNode; readonly auth?: undefined; readonly connection?: undefined }
  );

/**
 * Makes Minca available to every component below it, so they ask for what
 * they need — `useNode()`, `useQuery(space, …)` — instead of having it passed
 * down.
 *
 * ```tsx
 * <MincaProvider connection={connection}>   // an app, through an account home
 * <MincaProvider auth={auth}>               // the home itself
 * ```
 */
export function MincaProvider(props: MincaProviderProps): ReactElement {
  const auth = props.auth ?? null;
  const connection = props.connection ?? null;
  const authState = useStore<AuthState>(auth);
  const connectionState = useStore<MincaConnectionState>(connection);
  const node =
    props.node ??
    authState?.session?.node ??
    (connectionState?.status === 'ready' ? connectionState.node : null);
  return createElement(MincaContext.Provider, { value: { auth, connection, node } }, props.children);
}

/** The sign-in flow from the nearest `MincaProvider`, and its state — or nulls, for an app that connects instead. */
export function useMinca(): {
  auth: MincaAuth | null;
  state: AuthState | null;
  session: MincaSession | null;
} {
  const { auth } = useContext(MincaContext);
  const state = useFollow<AuthState, null>(auth, nothing);
  return { auth, state, session: state?.session ?? null };
}

/**
 * The sign-in flow and its state, for screens that manage the account —
 * `auth.signOut()`, `auth.addPasskey()`, `state.entry`.
 * @throws Outside a `MincaProvider` given `auth`
 */
export function useAuth(): { auth: MincaAuth; state: AuthState } {
  const { auth, state } = useMinca();
  if (!auth || !state) throw new Error('useAuth needs a MincaProvider with an auth flow above it.');
  return { auth, state };
}

/**
 * Who is signed in: the account, its identity, and its node.
 * @throws Outside a `MincaProvider` given `auth`, or before sign-in
 */
export function useSession(): MincaSession {
  const { session } = useMinca();
  if (!session) throw new Error('useSession needs someone signed in.');
  return session;
}

/**
 * An app's connection to its account home, and its state — for the connect
 * button, and for "access ran out, connect again".
 * @throws Outside a `MincaProvider` given `connection`
 */
export function useConnection(): { connection: MincaConnection; state: MincaConnectionState } {
  const { connection } = useContext(MincaContext);
  const state = useFollow<MincaConnectionState, null>(connection, nothing);
  if (!connection || !state)
    throw new Error('useConnection needs a MincaProvider with a connection above it.');
  return { connection, state };
}

/**
 * The account this page acts for — signed in here, or connected through a
 * home: its identity (what `root` and `createdBy` on a record name) and name.
 * @throws Before sign-in or connecting
 */
export function useAccount(): { did: string; name: string } {
  const { auth, connection } = useContext(MincaContext);
  const authState = useFollow<AuthState, null>(auth, nothing);
  const connectionState = useFollow<MincaConnectionState, null>(connection, nothing);
  if (authState?.session) return { did: authState.session.did, name: authState.session.account.name };
  if (connectionState?.grant) return { did: connectionState.grant.did, name: connectionState.grant.name };
  throw new Error('useAccount needs someone signed in or connected.');
}

/**
 * The node acting for the account. For components that only appear once
 * someone is in.
 * @throws Outside a `MincaProvider`, or before sign-in or connecting
 */
export function useNode(): P2PNode {
  const { node } = useContext(MincaContext);
  if (!node) throw new Error('useNode needs a signed-in or connected MincaProvider above it.');
  return node;
}
