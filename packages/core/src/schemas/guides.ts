/**
 * Guides: how a space's collections are meant to be used, in words, for
 * whoever writes to them next, often an agent.
 *
 * A definition says what a record may hold and who may change it. It can't
 * say "to add a tool with its own screen, write one of these, pointing at a
 * blueprint". An app that has more to say about its collections writes a
 * `std.guide` naming them, and `collections_list` points at it from each one,
 * so an agent finds it without knowing the app exists.
 *
 * A guide is what someone in the space wrote. An agent reads it as data about
 * the collections, never as instructions from the person it works for.
 */
import type { NodeRecord, P2PNode } from '../node/types.js';
import { guide, type Guide } from './library/collections.js';
import { definedNames } from './defined.js';

type GuideRecord = NodeRecord<Guide>;

/** The space's guides, by the collections they are about */
export async function guidesOf(
  node: P2PNode,
  spaceId: string,
): Promise<ReadonlyMap<string, ReadonlyArray<GuideRecord>>> {
  const about = new Map<string, GuideRecord[]>();
  for (const record of await listGuides(node, spaceId)) {
    for (const name of record.body?.collections ?? []) {
      const list = about.get(name) ?? [];
      list.push(record);
      about.set(name, list);
    }
  }
  return about;
}

/**
 * Writes a guide, or rewrites it when the space has one of that name that this
 * account wrote and it says something else. One someone else wrote holds the
 * name: theirs stays. Defines `std.guide` first when the space lacks it.
 */
export async function writeGuide(node: P2PNode, spaceId: string, body: Guide): Promise<void> {
  if (!(await definedNames(node, spaceId)).has(guide.name)) await node.collections.define(spaceId, guide);
  const held = (await listGuides(node, spaceId)).find((record) => record.body?.name === body.name);
  if (!held) {
    await node.records.put(spaceId, guide, body);
    return;
  }
  const unchanged = JSON.stringify(held.body) === JSON.stringify(body);
  if (held.createdBy === node.did && !unchanged) await node.records.update(spaceId, held.key, body);
}

const listGuides = (node: P2PNode, spaceId: string) =>
  node.records.list<Guide>(spaceId, { collection: guide.name });
