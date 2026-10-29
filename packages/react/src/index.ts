/**
 * @module react
 * React bindings: follow the sign-in flow, draw it, and keep what you read from
 * a space live as records sync in.
 *
 * ```tsx
 * const auth = createMincaAuth({ network: { relays } });
 *
 * function Root() {
 *   return <MincaProvider auth={auth}><App /></MincaProvider>;
 * }
 *
 * function App() {
 *   const { state } = useMinca();
 *   if (state?.stage !== 'ready') return <MincaAuth auth={auth} />;
 *   return <Todos space={…} />;
 * }
 *
 * function Todos({ space }) {
 *   const { result } = useQuery(space, { collection: 'app.todo.item', sort: { '@createdAt': 'asc' } });
 *   const node = useNode();   // to write: node.records.put(space, 'app.todo.item', { text })
 *   …
 * }
 * ```
 *
 * `react` and `@minca/core` are peer dependencies; core is read only through
 * its public entry points.
 */
export {
  MincaProvider,
  useMinca,
  useAuth,
  useSession,
  useConnection,
  useAccount,
  useNode,
} from './context.js';
export type { MincaProviderProps } from './context.js';
export { MincaAuth } from './minca-auth.js';
export type { MincaAuthProps } from './minca-auth.js';
export { useAsync } from './use-async.js';
export type { AsyncState } from './use-async.js';
export { useLive } from './use-live.js';
export { useWatched } from './use-watched.js';
export { useAccountPicture, useObjectUrl } from './use-account-picture.js';
export type { Watch } from './use-watched.js';
export { useQuery } from './use-query.js';
export type { QueryState } from './use-query.js';
export { useSpaces } from './use-spaces.js';
export type { SpacesOptions, SpacesState } from './use-spaces.js';
export { useMyName } from './use-my-name.js';
export { useNames } from './use-names.js';
export { useInviteLink, inviteLink, inviteFromLink } from './use-invite-link.js';
export {
  useHoldSpace,
  useRecord,
  useLinked,
  useCollections,
  useProfiles,
  useAccess,
  useSpaceStatus,
  useCan,
} from './use-space.js';
export { useNetwork } from './use-network.js';
