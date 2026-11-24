import { useWatched } from '@minca/react';

/**
 * How many segments of the account's own space this version does not read.
 * That space is kept wherever the account is, so a pod or mirror of another
 * format shows there. Undefined until first read.
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

/** Says that data this version can't read is there and not shown, so its absence doesn't look like waiting */
export function UnreadableData() {
  const unreadableSegments = useUnreadableAccountSegments();
  if (!unreadableSegments) return null;
  return (
    <aside data-tone="warn" className="stack" role="status">
      <strong>This version of Minca can’t read some of your data</strong>
      <p>It isn’t shown here. This device has left it as it was.</p>
    </aside>
  );
}
