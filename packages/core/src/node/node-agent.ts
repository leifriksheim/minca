/**
 * @module node-agent
 * An agent acting through a node: its own key, under a records-only note
 * the account gave it, reaching only the spaces that note names. What each
 * method may do is the table in `packages/core/src/node/api.ts`.
 */
import { didOf } from '../identity/did.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import { grantsRecordsOnly, noteSpaces } from '../identity/abilities.js';
import { isRecord } from '../utils/guards.js';
import type { CryptoProvider } from '../types.js';
import { CANNOT_DEFINE, type ActiveSession } from './space-runtime.js';
import { buildNamespaces, callMethod, givenFor, type Namespace, type OwnMethods } from './api.js';
import type { NodeEvent, NodeRecords, P2PNode } from './types.js';

interface AgentNeeds {
  readonly provider: CryptoProvider;
  readonly contactsSpaceId: string | null;
  /** The records namespace, writing as the given session */
  readonly recordsAs: (as: ActiveSession) => NodeRecords;
}

export async function startAgent(
  node: P2PNode,
  agent: { readonly keys: CryptoKeyPair; readonly note: Delegation },
  needs: AgentNeeds,
): Promise<P2PNode> {
  const { spaces, records, hosting, contacts, direct } = node;
  const { contactsSpaceId } = needs;
  const agentDid = await didOf(agent.keys.publicKey, needs.provider);
  const checked = await verifyNote(agent.note, needs.provider);
  if (!checked.valid) throw new Error(`The agent's note does not check out: ${checked.reason}`);
  const { note } = checked;
  if (!grantsRecordsOnly(note))
    throw new Error(
      'That note grants more than records — ask the account home for one with `recordsOnly: true`.',
    );
  if (note.payload.aud !== agentDid) throw new Error('That note was made out to a different key.');
  if (note.payload.iss !== node.did) throw new Error('That note is from a different account.');

  // The spaces its note names; all of them for an agent granted the whole account.
  // What it may do there is its note's to say; this node also refuses, by the label, what needs a person.
  const reach = noteSpaces(note);
  const named = new Set(reach === 'all' ? [] : reach);
  const allowed = (spaceId: unknown) =>
    reach === 'all' || (typeof spaceId === 'string' && named.has(spaceId));
  const contactsGiven = () => contactsSpaceId !== null && allowed(contactsSpaceId);
  // Written with the agent's key, under its note.
  const writes = needs.recordsAs({ did: agentDid, key: agent.keys.privateKey, proof: () => note });

  // What the table in `node/api.ts` marks `own`; the rest it decides there.
  const own: { readonly [N in Namespace as keyof OwnMethods<N> extends never ? never : N]: OwnMethods<N> } = {
    spaces: {
      list: async () => (await spaces.list()).filter((space) => allowed(space.id)),
      get: async (spaceId) => (allowed(spaceId) ? spaces.get(spaceId) : null),
      authenticator: async () => null,
    },
    records: {
      can: async (spaceId, action, target) => allowed(spaceId) && records.can(spaceId, action, target),
      watch: (spaceId, query, onResult, onError) => {
        if (allowed(spaceId)) return records.watch(spaceId, query, onResult, onError);
        onError?.(new Error('The agent was not given this space.'));
        return () => {};
      },
    },
    // The runtime refuses this too, and every peer ignores it — said early, with what to do instead.
    collections: {
      define: async () => {
        throw new Error(CANNOT_DEFINE);
      },
    },
    hosting: {
      space: async (spaceId) => {
        if (!allowed(spaceId)) throw new Error('That space was not given to this agent');
        return hosting.space(spaceId);
      },
      over: async (spaceId) => (allowed(spaceId) ? hosting.over(spaceId) : []),
    },
    contacts: {
      space: async () => (contactsGiven() ? contactsSpaceId : null),
      list: async () => (contactsGiven() ? contacts.list() : []),
      get: async (did) => (contactsGiven() ? contacts.get(did) : null),
    },
    direct: { reachable: async (spaceId) => (allowed(spaceId) ? direct.reachable(spaceId) : []) },
    inbox: { get: async () => null },
  };
  const person = (what: string) => async (): Promise<never> => {
    throw new Error(`An agent can't ${what}. Ask the person to do it.`);
  };

  return Object.freeze({
    did: node.did,
    sessionDid: agentDid,
    ...buildNamespaces((namespace, name, policy) => {
      if (policy === 'own') return givenFor(own, namespace, name);
      const source: unknown = namespace === 'records' ? writes : Reflect.get(node, namespace);
      if (!isRecord(source)) throw new Error(`A node has no ${namespace}`);
      if (policy === 'pass') return (...args: unknown[]) => callMethod(source, name, args);
      if (policy !== 'scoped') return person(policy);
      return async (...args: unknown[]) => {
        if (!allowed(args[0]))
          throw new Error(
            'The agent was not given this space. The person can give it more in their account home.',
          );
        return callMethod(source, name, args);
      };
    }),
    delegation: () => note,
    iceServers: () => node.iceServers(),
    asAgent: person('start another agent'),
    revokeKey: person('revoke a key'),
    revokeSelf: person('sign the account out'),
    subscribe: (listener: (event: NodeEvent) => void) =>
      node.subscribe((event) => {
        if (!('space' in event) || allowed(event.space)) listener(event);
      }),
    // The agent stops; the node it acts through keeps running.
    close: async () => {},
  }) satisfies P2PNode;
}
