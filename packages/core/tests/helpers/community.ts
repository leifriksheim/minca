/**
 * A community judged by one real node: a founder's node holds a public
 * space, the other members hold a role in it, and every member's versions
 * are signed by hand (each with a key of its own, as a separate device
 * would) and handed to the founder's node in whatever order a test says.
 * The verdicts are the library's own (`records.contracts`).
 */
import type { DefineCollection } from '../../src/node/types.js';
import type { Version } from '../../src/types.js';
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import { team } from '../../src/space/presets.js';
import { hold, letGo } from './hold.js';
import { forge, person, type Person } from './person.js';

/** How a reader judges a version: `fail` too when it doesn't stand */
type Verdict = 'pass' | 'fail' | 'pending' | 'unjudged';

type Fields = Parameters<typeof forge>[2];

export async function communityNode(others: number, collections: ReadonlyArray<DefineCollection>) {
  const founder = await person();
  const members = await Promise.all(Array.from({ length: others }, () => person()));
  const { id: space } = await founder.node.spaces.create({
    name: 'Community',
    ...team,
    visibility: 'public',
  });
  for (const m of members) await founder.node.spaces.assign(space, m.node.did, 'editor');
  for (const c of collections) await founder.node.collections.define(space, c);
  await hold(founder.node, space);

  /** The access changes the founder's node holds now: what a version written now names as seen */
  const heads = async () => (await founder.node.spaces.access(space)).heads;

  const verdict = async (v: Version): Promise<Verdict> => {
    const found = await founder.node.records.contracts(space, v.key, v.id);
    if (!found) return 'fail';
    if (found.pending) return 'pending';
    if (found.unjudged) return 'unjudged';
    return found.passes === false ? 'fail' : 'pass';
  };

  return {
    founder,
    members,
    space,
    heads,
    /** A version signed by `who`, under a new key of theirs, kept nowhere yet */
    async sign(
      who: Person,
      fields: Omit<Fields, 'seen'> & { seen?: ReadonlyArray<string> },
    ): Promise<Version> {
      return forge(
        who,
        space,
        { retain: true, ...fields, seen: fields.seen ?? (await heads()) },
        { keep: false },
      );
    },
    /** Hands versions to the founder's node, as if they had arrived */
    async add(...versions: Version[]): Promise<void> {
      await letGo(founder.node, space);
      const storage = createStorageProvider(await founder.stores(`spaces/${space}`));
      for (const v of versions) await storage.addVersion(v);
      await hold(founder.node, space);
    },
    verdict,
    async verdicts(...versions: Version[]): Promise<Verdict[]> {
      const out: Verdict[] = [];
      for (const v of versions) out.push(await verdict(v));
      return out;
    },
  };
}
export type Community = Awaited<ReturnType<typeof communityNode>>;
