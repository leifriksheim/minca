import { type ShapeKind } from '@minca/ui/shapes';
import { Shape } from './shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import styles from './Loader.module.css';

/**
 * Minca's loader: five shapes in a row, each hopping and turning a little in
 * turn, like hands going up one after another. Use it wherever something is
 * on its way (a space opening, records loading, a peer being found) in place
 * of "Loading…" on its own.
 *
 * Under `prefers-reduced-motion` the shapes stand still.
 */

const HANDS: ReadonlyArray<{ kind: ShapeKind; colour: ShapeColour }> = [
  { kind: 'scallop', colour: 'cobalt' },
  { kind: 'flower', colour: 'coral' },
  { kind: 'half', colour: 'peach' },
  { kind: 'star', colour: 'sage' },
  { kind: 'clover', colour: 'lilac' },
];

export function Loader({
  size = 14,
  label = 'Loading',
  showLabel = false,
  decorative = false,
}: {
  /** Each shape's width and height in pixels */
  size?: number;
  /** What is loading, in a few words ("Opening the space") */
  label?: string;
  /** Show the label beside the shapes, not only to screen readers */
  showLabel?: boolean;
  /** Just the shapes, as ornament: no status for screen readers */
  decorative?: boolean;
}) {
  return (
    <span
      className={styles.loader}
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative || undefined}
      // eslint-disable-next-line react/forbid-dom-props -- the spacing scales with the shapes' size
      style={{
        gap: Math.round(size * 0.3),
        paddingTop: Math.round(size * 0.4),
      }}
    >
      {HANDS.map((hand) => (
        <Shape key={hand.kind} kind={hand.kind} colour={hand.colour} size={size} />
      ))}
      {decorative ? null : showLabel ? (
        <small>{label}…</small>
      ) : (
        <span className={styles.hidden}>{label}</span>
      )}
    </span>
  );
}
