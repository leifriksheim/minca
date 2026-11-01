/** When something last happened in your spaces, for the home screen to put the liveliest first. */
import type { NodeEvent, SpaceSummary } from '@minca/core';
import { useWatched } from '@minca/react';

/**
 * When each space was last written in: its newest record, of any app, or
 * when it began while it has none. Kept current as records arrive in any of
 * them, here or from elsewhere.
 */
export function useLastActive(spaces: ReadonlyArray<SpaceSummary>): ReadonlyMap<string, string> {
  const ids = spaces.map((space) => space.id);
  const key = ids.join(',');
  const found = useWatched(
    async (node) =>
      new Map(
        await Promise.all(
          spaces.map(async (space) => {
            const [newest] = await node.records
              .list(space.id, { newestFirst: true, limit: 1 })
              .catch(() => []);
            return [space.id, newest?.createdAt ?? space.createdAt] as const;
          }),
        ),
      ),
    [key],
    {
      when: (event: NodeEvent) => event.type === 'records' && ids.includes(event.space),
      settle: 400,
    },
  );
  return found ?? NONE;
}

const NONE: ReadonlyMap<string, string> = new Map();

/** Spaces with the one written in most recently first, by `useLastActive`'s times */
export const byRecent = <T extends { readonly space: SpaceSummary }>(
  items: ReadonlyArray<T>,
  last: ReadonlyMap<string, string>,
): ReadonlyArray<T> => {
  const at = (item: T) => last.get(item.space.id) ?? item.space.createdAt;
  return [...items].sort((a, b) => at(b).localeCompare(at(a)));
};
