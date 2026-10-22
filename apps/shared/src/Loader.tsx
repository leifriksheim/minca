import type { CSSProperties } from 'react';
import { type ShapeKind } from '@minca/ui/shapes';
import { Shape } from './shapes';
import { ink, type ShapeColour } from '@minca/ui/tokens';

/**
 * Minca's loader: five shapes in a row, each hopping and turning a little in
 * turn, like hands going up one after another. Use it wherever something is
 * on its way (a space opening, records loading, a peer being found) in place
 * of "Loading…" on its own.
 *
 * It brings its own keyframes (React puts the style in the head once, however
 * many loaders are on screen), so it works in every app and on the site.
 * Under `prefers-reduced-motion` the shapes stand still.
 */

const HANDS: ReadonlyArray<{ kind: ShapeKind; colour: ShapeColour }> = [
  { kind: 'scallop', colour: 'cobalt' },
  { kind: 'flower', colour: 'coral' },
  { kind: 'half', colour: 'peach' },
  { kind: 'star', colour: 'sage' },
  { kind: 'clover', colour: 'lilac' },
];

const CSS = `
@keyframes minca-hop {
  0%, 60%, 100% { transform: translateY(0) rotate(0); }
  30% { transform: translateY(-36%) rotate(20deg); }
}
.minca-loader .shape { animation: minca-hop 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .minca-loader .shape { animation: none; } }
`;

/** Read by screen readers, hidden from the eye */
const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

export function Loader({
  size = 14,
  label = 'Loading',
  showLabel = false,
  decorative = false,
  style,
}: {
  /** Each shape's width and height in pixels */
  size?: number;
  /** What is loading, in a few words ("Opening the space") */
  label?: string;
  /** Show the label beside the shapes, not only to screen readers */
  showLabel?: boolean;
  /** Just the shapes, as ornament: no status for screen readers */
  decorative?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className="minca-loader"
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.round(size * 0.3),
        paddingTop: Math.round(size * 0.4),
        ...style,
      }}
    >
      <style href="minca-loader" precedence="minca">
        {CSS}
      </style>
      {HANDS.map((hand, i) => (
        <Shape
          key={hand.kind}
          kind={hand.kind}
          colour={hand.colour}
          size={size}
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
      {decorative ? null : showLabel ? (
        <span style={{ marginLeft: Math.round(size * 0.5), fontSize: 13, color: ink.muted }}>{label}…</span>
      ) : (
        <span style={HIDDEN}>{label}</span>
      )}
    </span>
  );
}
