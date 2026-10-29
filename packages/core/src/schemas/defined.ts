import type { NodeCollection, P2PNode } from '../node/types.js';

/** The names of the collections that have a definition, not only records */
export const definedIn = (collections: ReadonlyArray<NodeCollection>): ReadonlySet<string> =>
  new Set(collections.filter((c) => c.version !== null).map((c) => c.name));

/** The names of the collections a space has a definition for */
export async function definedNames(node: P2PNode, space: string): Promise<ReadonlySet<string>> {
  return definedIn(await node.collections.list(space));
}
