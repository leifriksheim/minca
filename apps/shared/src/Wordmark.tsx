import { MARK_BANDS, MARK_VIEWBOX } from './mark';
import styles from './Wordmark.module.css';

/**
 * Minca's mark and wordmark. A minca (minka, in the Andes) is when everyone
 * turns out to build what serves them all: a bridge, a school, the harvest.
 */

/** The mark, `size` pixels wide */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 13) / 24} viewBox={MARK_VIEWBOX} aria-hidden>
      {MARK_BANDS.map((b) => (
        <path key={b.fill} d={b.d} fill={b.fill} />
      ))}
    </svg>
  );
}

/** The product's name, small, above every onboarding step. `compact` is no longer different. */
export function Wordmark(_props: { compact?: boolean }) {
  return (
    <div className={styles.wordmark}>
      <Mark size={24} />
      <span>minca</span>
    </div>
  );
}
