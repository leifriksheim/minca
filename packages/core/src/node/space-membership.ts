/**
 * @module node/space-membership
 * Who may do what in a space, as this account changes it: roles, members,
 * invites, keys revoked, relays and keepers. Every change is a record in the
 * access history (`space-history.ts`), refused here, with the reason, when
 * every peer would refuse it.
 */
import {
  SPACE_RELAYS_RECORD,
  SPACE_KEEPERS_RECORD,
  deriveInviteKey,
  generateInviteSecret,
  inviteKey as inviteRecordKey,
  assignKey,
  removalKey,
  revokeKey,
  roleKey,
  signInvite,
  stepDownKey,
  succeedKey,
} from '../space/space-access.js';
import { isSpaceId } from '../space/constitution.js';
import {
  ASSIGN_COLLECTION,
  INVITE_COLLECTION,
  RELAYS_COLLECTION,
  checkRelays,
  KEEPERS_COLLECTION,
  checkKeepers,
  type Keeper,
  REMOVE_COLLECTION,
  REVOKE_COLLECTION,
  ROLE_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
  headless,
  isMember,
  holdsRole,
  may,
  readers,
  rolesOf,
} from '../space/roles.js';
import { checkFoundingRole, definitionBody, type FoundingRole } from '../space/grants.js';
import { base64UrlEncode } from '../utils/encoding.js';
import type { FlaggedAccount, NodeRecord, SpaceAccess } from './types.js';
import type { History } from './space-history.js';
import type { Keys } from './space-keys.js';
import type { SpaceBase } from './space-versions.js';
import { withCutoff, type Lines } from './space-lines.js';
import type { Writing } from './space-writing.js';
import type { Peers } from './space-peers.js';

export interface MembershipDeps extends SpaceBase {
  /** Whether a network is configured: without one, a peer can't come to take a write */
  readonly networked: boolean;
  readonly history: History;
  readonly keys: Keys;
  readonly lines: Lines;
  readonly writing: Writing;
  readonly peers: Peers;
  readonly meeting: { readonly relays: () => ReadonlyArray<string> };
  readonly flagged: () => Promise<ReadonlyArray<FlaggedAccount>>;
  readonly onJoined: (() => void) | undefined;
}

export function createMembership(deps: MembershipDeps) {
  const { record, provider, history, writing, peers } = deps;
  const { space } = record;
  const { access } = history;
  const { upsert } = writing;
  const { cutoffFor } = deps.lines;
  const { currentKey, changeKeyNow } = deps.keys;

  /**
   * Assigns a role to an account, or with `assigned: false` takes it away:
   * one's own, to leave it. Taking a role leaves what this node has seen
   * them write in it standing.
   */
  async function assign(did: string, role: string, assigned: boolean): Promise<NodeRecord<unknown>> {
    const { history } = await access();
    if (!history.current.roles.has(role)) throw new Error(`There is no role "${role}" in "${space.name}"`);
    const takes = !assigned && rolesOf(history.current, did).includes(role);
    const cutoff = takes ? await cutoffFor(did) : {};
    const body = withCutoff({ did, role, assigned }, cutoff);
    const written = await upsert(ASSIGN_COLLECTION, await assignKey(did, role), body);
    await changeKeyNow();
    return written;
  }

  /** Removes an account from the space, every role it holds with it: one's own, to leave */
  async function removeAccount(did: string): Promise<NodeRecord<unknown>> {
    const { history } = await access();
    if (!isMember(history.current, did)) throw new Error(`They hold no place in "${space.name}"`);
    const cutoff = await cutoffFor(did);
    const written = await upsert(REMOVE_COLLECTION, await removalKey(did), withCutoff({ did }, cutoff));
    await changeKeyNow();
    return written;
  }

  return {
    async setRelays(named: ReadonlyArray<string>) {
      const problem = checkRelays(named);
      if (problem) throw new Error(problem);
      await upsert(RELAYS_COLLECTION, SPACE_RELAYS_RECORD, { relays: [...named] });
    },

    async setKeepers(keepers: ReadonlyArray<Keeper>, copies: number | null = null) {
      const named = keepers.map((k) => ({ did: k.did, name: k.name }));
      const problem = checkKeepers(named, copies);
      if (problem) throw new Error(problem);
      await upsert(KEEPERS_COLLECTION, SPACE_KEEPERS_RECORD, { keepers: named, copies });
    },

    async access(): Promise<SpaceAccess> {
      const { history } = await access();
      const state = history.current;
      const members = [...readers(state)].sort();
      return Object.freeze({
        roles: [...state.roles]
          .map(([name, definitions]) => ({
            name,
            ...(definitions[0]?.title !== undefined ? { title: definitions[0].title } : {}),
            definitions: definitions.map((definition) => ({
              event: definition.event,
              by: definition.by,
              grants: definition.grants,
              nests: definition.nests,
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        members: members.map((did) => ({
          did,
          founder: state.founders.has(did),
          roles: rolesOf(state, did),
        })),
        invites: [...state.invites].map(([inviteDid, invite]) => ({
          key: inviteDid,
          role: invite.role,
          open: invite.open,
        })),
        founder: state.founders.has(deps.rootDid),
        top: space.top === 'none' ? 'none' : 'founders',
        headless: headless(state),
        successors: [...state.successors].map(([successor, by]) => ({ space: successor, by })),
        mine: rolesOf(state, deps.rootDid),
        heads: history.heads(),
        key: state.keys.length ? { changes: state.keys.length - 1, held: currentKey(state) !== null } : null,
        relays: state.relays.length ? state.relays : deps.meeting.relays(),
        keepers: state.keepers,
        copies: state.copies,
        forks: history.forks(),
        flagged: await deps.flagged(),
      });
    },

    /** Whether this account, or another, may invoke a command with these arguments, now */
    async may(
      cmd: string,
      args: Readonly<Record<string, unknown>> = {},
      account: string = deps.rootDid,
    ): Promise<boolean> {
      return may((await access()).history.current, account, cmd, args);
    },

    /** Whether this account, or another, holds every grant a role gives, as wide or wider, now */
    async holdsRole(role: string, account: string = deps.rootDid): Promise<boolean> {
      return holdsRole((await access()).history.current, account, role);
    },

    async assign(did: string, role: string) {
      await assign(did, role, true);
    },

    async unassign(did: string, role: string) {
      await assign(did, role, false);
    },

    async removeMember(did: string) {
      await removeAccount(did);
    },

    /** Stops being a founder, keeping the roles held, and `keep` first when given */
    async stepDown(keep?: string) {
      const { history } = await access();
      if (!history.current.founders.has(deps.rootDid))
        throw new Error(`You are not a founder of "${space.name}"`);
      if (keep !== undefined && !rolesOf(history.current, deps.rootDid).includes(keep))
        await assign(deps.rootDid, keep, true);
      if (rolesOf((await access()).history.current, deps.rootDid).length === 0)
        throw new Error(
          `You hold no role in "${space.name}", so stepping down would leave it: keep a role, or leave`,
        );
      const cutoff = await cutoffFor(deps.rootDid);
      const body = withCutoff({ did: deps.rootDid }, cutoff);
      await upsert(STEPDOWN_COLLECTION, await stepDownKey(deps.rootDid), body);
    },

    /** Names a space that succeeds this one. It changes nothing here */
    async succeed(successor: string) {
      if (!isSpaceId(successor) || successor === space.id)
        throw new Error('A successor is named by its space id');
      // Refused here, with the reason, when this account may not: as every peer would.
      await upsert(SUCCEED_COLLECTION, await succeedKey(successor), { space: successor });
    },

    /**
     * Gives up this account's place before it forgets the space: its own
     * member record with no role, so the others stop counting it a reader and
     * a key change becomes due. Nothing sends the removal once the space is
     * closed, so this waits up to `waitMs` for a peer of another account to
     * say it has it. False when it couldn't be written, or nobody took it in
     * time.
     */
    async giveUpPlace(waitMs: number): Promise<boolean> {
      const state = (await access()).history.current;
      // Shared to view, or already gone: there is nothing to remove.
      if (!isMember(state, deps.rootDid)) return true;
      // Nobody else holds a place, so nobody else needs to know.
      if ([...readers(state)].every((did) => did === deps.rootDid)) return true;
      try {
        return await peers.writeUntilStored(async () => (await removeAccount(deps.rootDid)).version, {
          waitMs,
          othersOnly: true,
          reachable: true,
        });
      } catch {
        // A note that may not change access; another of the account's devices can.
        return false;
      }
    },

    /** Writes a role's definition: its grants, issued by this account, and the roles it nests */
    async defineRole(role: FoundingRole) {
      const problem = checkFoundingRole(role);
      if (problem) throw new Error(problem);
      const nonce = () => base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      await upsert(
        ROLE_COLLECTION,
        roleKey(role.name),
        definitionBody(role, { root: deps.rootDid, spaceId: space.id }, nonce),
      );
    },

    /** Opens an invite to a role, with its own fresh secret unless a short link's gives it one */
    async openInvite(role: string, secret: Uint8Array = generateInviteSecret()) {
      const pair = await deriveInviteKey(secret, provider);
      await upsert(INVITE_COLLECTION, await inviteRecordKey(pair.did), { key: pair.did, role, open: true });
      return { secret, key: pair.did };
    },

    async closeInvite(inviteDid: string) {
      const { history } = await access();
      const invite = history.current.invites.get(inviteDid);
      if (!invite) throw new Error('There is no such invite in this space');
      // Who joined with it before this node closed it stays: the close names what it saw, and the replay does the rest.
      await upsert(INVITE_COLLECTION, await inviteRecordKey(inviteDid), {
        key: inviteDid,
        role: invite.role,
        open: false,
      });
    },

    /**
     * Revokes a key of this account's. With `waitMs`, it then waits up to that
     * long for a peer to say it has the revoke: a device about to stop sends
     * nothing after, so true means it left. A node with no network configured
     * can't send it anywhere, so false at once. Without, true once written.
     */
    async revoke(key: string, options: { readonly waitMs?: number } = {}): Promise<boolean> {
      const waitMs = options.waitMs ?? 0;
      const write = async () => {
        const cutoff = await cutoffFor(deps.rootDid, key);
        const body = withCutoff({ key }, cutoff);
        return (await upsert(REVOKE_COLLECTION, await revokeKey(key, deps.rootDid), body)).version;
      };
      if (waitMs <= 0) {
        await write();
        return true;
      }
      // With a network configured a peer may still be on its way, through a socket not yet
      // joined or a host not yet reached; with none, nobody can come.
      return peers.writeUntilStored(write, { waitMs, othersOnly: false, reachable: deps.networked });
    },

    async isRevoked(key: string) {
      return (await access()).history.revoked(key, deps.rootDid).length > 0;
    },

    /** Uses an invite's secret, once its record has arrived. True when this account is a member. */
    async join(secret: Uint8Array) {
      const { history } = await access();
      const pair = await deriveInviteKey(secret, provider);
      const invite = history.current.invites.get(pair.did);
      if (
        isMember(history.current, deps.rootDid) &&
        (!invite || rolesOf(history.current, deps.rootDid).includes(invite.role))
      ) {
        writing.joined();
        deps.onJoined?.();
        return true;
      }
      if (!invite?.open) return false;
      await upsert(
        ASSIGN_COLLECTION,
        await assignKey(deps.rootDid, invite.role),
        {
          did: deps.rootDid,
          role: invite.role,
          assigned: true,
          invite: { key: pair.did, signature: await signInvite(space.id, deps.rootDid, pair, provider) },
        },
        { joining: true },
      );
      writing.joined();
      deps.onJoined?.();
      return true;
    },
  };
}
