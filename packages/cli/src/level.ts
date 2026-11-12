/**
 * A node that runs for one call, the MCP service's or a CLI command's an agent
 * runs, as the agent: before it reads or writes in a space it holds what the
 * space's always-on nodes hold, or does nothing (`catchUp`), since a node
 * behind would say a record isn't there, and write a first version in a line
 * that has one, which ends it (09 §7.5); and a write is done once they have it
 * (`keptAfter`). The same rule for both, so neither front end is the weaker.
 */
import type { P2PNode } from '@minca/core';

/** How long a call waits for its node to be level with an always-on node in its space */
const CATCH_UP_MS = 15_000;

/** How long a call that writes waits for the space's carriers to have what it wrote */
const KEPT_MS = 10_000;

/**
 * Waits up to `waitMs` for the node to be level with the space's carriers
 * connected now, and at least one: nothing in flight either way, so it holds
 * what they hold. Only carriers count, the nodes the space names to keep it
 * whole: any member may connect and never answer. In a space that names
 * none, any one peer that is level will do. False when it wasn't, in time.
 */
async function levelIn(node: P2PNode, space: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const [peers, carriers] = await Promise.all([
      node.spaces.status(space).then(
        (status) => status.peers,
        () => [],
      ),
      node.spaces.access(space).then(
        (access) => new Set(access.carriers.map((carrier) => carrier.did)),
        () => new Set<string>(),
      ),
    ]);
    const asked = carriers.size > 0 ? peers.filter((peer) => carriers.has(peer)) : peers;
    const level = await Promise.all(
      asked.map((peer) => node.spaces.reached(space, peer, Math.min(2000, left)).catch(() => false)),
    );
    if (carriers.size > 0 ? level.length > 0 && level.every(Boolean) : level.some(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, left)));
  }
}

/** Waits for the node to be level in the space; refuses when it can't be, in time, saying why */
export async function catchUp(node: P2PNode, space: string): Promise<void> {
  if (await levelIn(node, space, CATCH_UP_MS)) return;
  const listed = await node.spaces.list().catch(() => []);
  if (!listed.some((one) => one.id === space))
    throw new Error(
      `There is no space ${space} here: spaces_list shows the ones this connection can use. ` +
        'If the person just joined it, try again in a moment.',
    );
  const status = await node.spaces.status(space).catch(() => null);
  throw new Error(
    status && status.peers.length === 0
      ? 'Nobody who keeps this space is online right now: no always-on node, and no member’s device. ' +
          'Try again later, or ask the person to open Minca.'
      : 'This space’s always-on nodes didn’t answer in time, so what is here may be behind. Try again in a moment.',
  );
}

/**
 * Waits for a write made since `since` to be kept elsewhere. Null when the
 * space's carriers have it; what to say when only a member's device does.
 * @throws When nobody has it yet: read it back before writing it again
 */
export async function keptAfter(node: P2PNode, space: string, since: number): Promise<string | null> {
  const by = await node.spaces.kept(space, KEPT_MS, since);
  if (by === 'carriers') return null;
  if (by === 'peer')
    return (
      'Kept by a device of this space that is online now, not by an always-on host: it reaches the others ' +
      'when that device syncs with them. Say so if it matters.'
    );
  throw new Error(
    'Written, but not yet kept elsewhere: the space’s always-on nodes haven’t all confirmed it, or, if ' +
      'it names none, no member online has it. It is sent when they are reachable: read it back before ' +
      'writing it again.',
  );
}
