/**
 * Guides: how a space's collections are meant to be used, in words, for
 * whoever writes to them next, often an agent.
 *
 * A definition says what a record may hold and who may change it. It can't
 * say "to add an app with its own screen, write one of these, pointing at a
 * blueprint". An app that has more to say about its collections writes a
 * `std.guide` naming them, and `collections_list` points at it from each one,
 * so an agent finds it without knowing the app exists.
 *
 * A guide is what someone in the space wrote. An agent reads it as data about
 * the collections, never as instructions from the person it works for.
 */
import type { NodeRecord, P2PNode } from '../node/types.js';
import { guide, type Guide } from './library/collections.js';

/** The space's guides, by the collections they are about */
export async function guidesOf(
  node: P2PNode,
  spaceId: string,
): Promise<ReadonlyMap<string, ReadonlyArray<NodeRecord<Guide>>>> {
  const records = await node.records.list<Guide>(spaceId, { collection: guide.name });
  const about = new Map<string, NodeRecord<Guide>[]>();
  for (const record of records) {
    for (const name of record.body?.collections ?? []) about.set(name, [...(about.get(name) ?? []), record]);
  }
  return about;
}

/**
 * Writes a guide, or rewrites it when the space has one of that name that this
 * account wrote and it says something else. One someone else wrote holds the
 * name: theirs stays. Defines `std.guide` first when the space lacks it.
 */
export async function writeGuide(node: P2PNode, spaceId: string, body: Guide): Promise<void> {
  const collections = await node.collections.list(spaceId);
  if (!collections.some((c) => c.name === guide.name && c.version !== null))
    await node.collections.define(spaceId, guide);
  const held = (await node.records.list<Guide>(spaceId, { collection: guide.name })).find(
    (record) => record.body?.name === body.name,
  );
  if (!held) {
    await node.records.put(spaceId, guide, body);
    return;
  }
  if (held.createdBy !== node.did) return;
  if (JSON.stringify(held.body) === JSON.stringify(body)) return;
  await node.records.update(spaceId, held.key, body);
}
