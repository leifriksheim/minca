/**
 * Making a space an assembly: the collections Liquid keeps there, and a few
 * topics to start from. Whoever may define collections does it the first time
 * Liquid opens the space; for anyone else it waits for them.
 */
import type { P2PNode } from '@minca/core';
// Defines what a space lacks; not a React hook, whatever its name says.
import { useSchemas as addSchemas } from '@minca/core/schemas';
import { ASSEMBLY, topic } from './schema';

/** Makes a space an assembly, as far as this account may; whether it is one now */
export async function becomeAssembly(node: P2PNode, spaceId: string): Promise<boolean> {
  if (!(await isAssembly(node, spaceId))) await prepareAssembly(node, spaceId);
  return isAssembly(node, spaceId);
}

/** Whether a space holds every collection an assembly needs */
async function isAssembly(node: P2PNode, spaceId: string): Promise<boolean> {
  const here = new Set(
    (await node.collections.list(spaceId)).filter((c) => c.version !== null).map((c) => c.name),
  );
  return ASSEMBLY.every((definition) => here.has(definition.name));
}

async function prepareAssembly(node: P2PNode, spaceId: string): Promise<void> {
  await addSchemas(node, spaceId, ASSEMBLY);
  // A few topics to start from, when this account may set them; moderators change them later.
  if (!(await node.records.can(spaceId, 'create', topic.name))) return;
  if ((await node.records.list(spaceId, { collection: topic.name })).length > 0) return;
  for (const [name, hue] of [
    ['Budget', 150],
    ['Events', 28],
    ['Rules', 262],
  ] as const)
    await node.records.put(spaceId, topic, { name, hue });
}
