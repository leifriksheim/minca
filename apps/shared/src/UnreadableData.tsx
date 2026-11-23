import { useWatched } from '@minca/react';

/**
 * How many segments of the account's own space this version does not read.
 * That space is kept wherever the account is, so a pod or mirror another
 * version saved shows there. Undefined until first read.
 */
function useUnreadableAccountSegments(): number | undefined {
  return useWatched(
    async (node) => {
      const accountSpace = await node.account.space();
      return accountSpace ? (await node.spaces.status(accountSpace)).unreadable : 0;
    },
    [],
    { when: (event) => event.type === 'status' },
  );
}

/** Says that data another version of Minca saved is there and not shown, so its absence doesn't look like waiting */
export function UnreadableData() {
  const unreadableSegments = useUnreadableAccountSegments();
  if (!unreadableSegments) return null;
  return (
    <aside data-tone="warn" className="stack" role="status">
      <strong>Some of your data was saved by another version of Minca</strong>
      <p>
        This version can’t read it, so it isn’t shown. Nothing was deleted: the version that saved it can
        still open it.
      </p>
    </aside>
  );
}
