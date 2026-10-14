import { MARK_BANDS, MARK_VIEWBOX } from './mark';
import { display, ink } from './tokens';

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

/** The product's name, small, above every onboarding step */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: compact ? 0 : 40 }}>
      <Mark size={24} />
      <span
        style={{
          fontFamily: display,
          fontWeight: 800,
          fontSize: 18,
          letterSpacing: '-0.05em',
          color: ink.strong,
        }}
      >
        minca
      </span>
    </div>
  );
}
