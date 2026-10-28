/**
 * `std.activity`: where agents and bots say what they are at work on. A space
 * whose automations ask one needs the collection.
 */
import { useCollections, useLive, useNode } from '@minca/react';
import { useMayDefine } from '@minca/app-shared/may';
import { activity, automation, automationOf } from '@minca/core/schemas';

/** Whether a space whose automations ask an agent or bot lacks `std.activity`, and a way to add it; never done on opening. */
export function useActivityOff(
  spaceId: string,
  writable: boolean,
): { readonly off: boolean; readonly turnOn: (() => Promise<void>) | null } {
  const node = useNode();
  const collections = useCollections(spaceId);
  const kept = collections.some((c) => c.name === activity.name && c.version !== null);
  const asks = useLive(
    spaceId,
    async (n) =>
      (await n.records.list(spaceId, { collection: automation.name })).some(
        (record) => automationOf(record)?.then.kind === 'ask',
      ),
    [],
  );
  const mayDefine = useMayDefine(spaceId, activity.name) && writable;
  return {
    off: !!asks && !kept,
    turnOn: mayDefine
      ? async () => {
          await node.collections.define(spaceId, activity);
        }
      : null,
  };
}
