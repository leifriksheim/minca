/**
 * @module node-direct
 * Direct messages in a space: sealed to the member keys of those they are
 * for, so only they read them (`packages/core/docs/direct-messages.md`).
 */
import { direct as directSchema } from '../schemas/library/publishing.js';
import { openDirect, sealDirect, type DirectBody } from '../privacy/direct.js';
import type { SpaceRuntime } from './space-runtime.js';
import type { DirectMessage, NodeDirect, NodeRecord } from './types.js';
import { ensureDefined, type NodeContext } from './node-context.js';

export function createNodeDirect(ctx: NodeContext): NodeDirect {
  const me = ctx.config.signer.did;

  /** A direct message as this account reads it — null when it is neither by nor for this account */
  async function directView(
    spaceId: string,
    open: SpaceRuntime,
    record: NodeRecord<DirectBody>,
  ): Promise<DirectMessage | null> {
    // Who wrote it is whoever created it: the context binds that account, so a copy posted by anyone else opens nothing.
    const from = record.createdBy;
    if (!record.verified || record.collection !== directSchema.name || !from || record.root !== from)
      return null;
    const to = Array.isArray(record.body?.to) ? record.body.to.filter((did) => typeof did === 'string') : [];
    if (from !== me && !to.includes(me)) return null;
    const pair = open.ownMemberKey();
    const opened = pair ? await openDirect(spaceId, from, record.body, me, pair) : null;
    return Object.freeze({
      key: record.key,
      from,
      to: [...to].sort(),
      text: opened?.text ?? null,
      createdAt: record.createdAt,
      ...(record.recordsOnly ? { recordsOnly: true as const } : {}),
    });
  }

  return Object.freeze<NodeDirect>({
    async reachable(spaceId) {
      const open = await ctx.runtime(spaceId);
      const { members } = await open.access();
      const keys = await open.memberKeys();
      return members
        .map((member) => member.did)
        .filter((did) => did !== me && keys.has(did))
        .sort();
    },

    async send(spaceId, to, text) {
      const open = await ctx.runtime(spaceId);
      const pair = open.ownMemberKey();
      if (!pair)
        throw new Error(
          "This node can't seal direct messages here: it wasn't given your member key for this space.",
        );
      const trimmed = text.trim();
      if (!trimmed) throw new Error('A direct message needs some text');
      // Your own key as this node holds it, so your other devices read what you sent even before it is published.
      const keys = new Map(await open.memberKeys());
      keys.set(me, pair.publicKey);
      const body = await sealDirect(spaceId, me, to, { text: trimmed }, keys);
      await ensureDefined(open, directSchema);
      const record = await open.put<DirectBody>(directSchema.name, body);
      const view = await directView(spaceId, open, record);
      if (!view) throw new Error('The direct message was written, but could not be read back');
      return view;
    },

    async list(spaceId) {
      const open = await ctx.runtime(spaceId);
      const found: DirectMessage[] = [];
      for (const record of await open.list<DirectBody>({ collection: directSchema.name })) {
        const view = await directView(spaceId, open, record);
        if (view) found.push(view);
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },
  });
}
