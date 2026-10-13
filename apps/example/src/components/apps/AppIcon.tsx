import { Shape, shapeFor } from '@weave/app-shared/shapes';
import type { Unread } from '../../seen';

/**
 * An app as its shape, the same wherever it appears: a built-in app's own,
 * and any other a round one picked by its id.
 */
export function AppIcon({ id, size, className }: { id: string; size: number; className?: string }) {
  return (
    <Shape {...shapeFor(id)} size={size} className={className ? `app-shape ${className}` : 'app-shape'} />
  );
}

const upTo99 = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * What is new, on a corner or at the end of a row; nothing when there is
 * nothing. Red with an @ when some of it names you, the way chat apps mark
 * mentions; quiet grey when it is only new.
 */
export function Count({ unread }: { unread: Unread }) {
  if (unread.count <= 0) return null;
  if (unread.forMe > 0)
    return (
      <span className="count" aria-label={`${unread.forMe} for you, ${unread.count} new`}>
        @{upTo99(unread.forMe)}
      </span>
    );
  return (
    <span className="count" data-quiet aria-label={`${unread.count} new`}>
      {upTo99(unread.count)}
    </span>
  );
}
