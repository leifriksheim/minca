import { Shape } from '@minca/app-shared/shapes';
import { shapeFor } from '@minca/ui/shapes';
import type { Unread } from '../../seen';
import type { AppEntry } from './entries';
import styles from './AppIcon.module.css';

/**
 * An app as its shape, the same wherever it appears: the icon its record gives it, or else a built-in
 * app's own, and any other a round one picked by its id.
 */
export function AppIcon({
  app,
  size,
  className,
}: {
  app: Pick<AppEntry, 'id' | 'icon'>;
  size: number;
  className?: string;
}) {
  const { kind, colour } = shapeFor(app.id);
  return (
    <Shape
      kind={kind}
      path={app.icon?.path}
      colour={app.icon?.colour ?? colour}
      size={size}
      className={className}
    />
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
      <span className={styles.count} aria-label={`${unread.forMe} for you, ${unread.count} new`}>
        @{upTo99(unread.forMe)}
      </span>
    );
  return (
    <span className={styles.count} data-quiet aria-label={`${unread.count} new`}>
      {upTo99(unread.count)}
    </span>
  );
}
