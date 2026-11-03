/**
 * Whether a node holds what a space's always-on nodes hold: what a node that
 * runs for one call, the MCP service's or a CLI command's, waits for before
 * it reads or writes there.
 */
import type { P2PNode } from '@minca/core';

/** How long a call waits for its node to be level with an always-on node in its space */
export const CATCH_UP_MS = 15_000;

/** How long a call that writes waits for the space's keepers to have what it wrote */
export const KEPT_MS = 10_000;

/**
 * Waits up to `waitMs` for the node to be level with the space's keepers
 * connected now, and at least one: nothing in flight either way, so it holds
 * what they hold. Only keepers count, the nodes the space names to keep it
 * whole: any member may connect and never answer. In a space that names
 * none, any one peer that is level will do. False when it wasn't, in time.
 */
export async function levelIn(node: P2PNode, space: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const [peers, keepers] = await Promise.all([
      node.spaces.status(space).then(
        (status) => status.peers,
        () => [],
      ),
      node.spaces.access(space).then(
        (access) => new Set(access.keepers.map((keeper) => keeper.did)),
        () => new Set<string>(),
      ),
    ]);
    const asked = keepers.size > 0 ? peers.filter((peer) => keepers.has(peer)) : peers;
    const level = await Promise.all(
      asked.map((peer) => node.spaces.reached(space, peer, Math.min(2000, left)).catch(() => false)),
    );
    if (keepers.size > 0 ? level.length > 0 && level.every(Boolean) : level.some(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, left)));
  }
}
