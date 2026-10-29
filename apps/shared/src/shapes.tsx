import { useEffect, useRef, type CSSProperties } from 'react';
import { ROUND, radial, type RoundKind } from '@minca/ui/round';
import { PATHS, type ShapeKind } from '@minca/ui/shapes';
import { shapeColours, type ShapeColour } from '@minca/ui/tokens';

/**
 * Minca's shapes in React: their paths are `@minca/ui/shapes`. The round ones
 * are each a radius for every angle (`@minca/ui/round`), so any two can melt
 * into each other: `Morph` blends one into the next.
 *
 * Shared by every UI (`packages/ui/DESIGN.md` says where each is used).
 * Give a shape a `colour` from the tokens, or leave it out and it fills with
 * the CSS custom property `--c`, as the site's colour classes set it.
 */

/** One shape, in one of the shapes' colours, or in `--c` when no colour is given */
export function Shape({
  kind,
  colour,
  size,
  className,
  style,
}: {
  kind: ShapeKind;
  colour?: ShapeColour;
  /** Width and height in pixels; leave it out to size the shape with CSS */
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className ? `shape ${className}` : 'shape'}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ display: 'block', flexShrink: 0, overflow: 'visible', ...style }}
      aria-hidden
    >
      <path d={PATHS[kind]} fill={colour ? shapeColours[colour] : 'var(--c, currentColor)'} />
    </svg>
  );
}

const HOLD_MS = 1500;
const MELT_MS = 900;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * A shape that keeps turning into the next one, and its colour with it. It
 * draws straight onto the path each frame, so React renders it once.
 */
export function Morph({
  steps,
  size,
  className,
}: {
  steps: ReadonlyArray<{ kind: RoundKind; colour: ShapeColour }>;
  size?: number;
  className?: string;
}) {
  const path = useRef<SVGPathElement>(null);

  useEffect(() => {
    const first = steps[0];
    if (!first || !path.current) return;
    path.current.setAttribute('d', PATHS[first.kind]);
    path.current.style.fill = shapeColours[first.colour];
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (still || steps.length < 2) return;

    let at = 0;
    let turned = false;
    let frame = 0;
    let started = performance.now();
    const tick = (now: number) => {
      const elapsed = now - started;
      const from = steps[at];
      const to = steps[(at + 1) % steps.length];
      if (from && to && elapsed > HOLD_MS) {
        if (!turned) {
          turned = true;
          if (path.current) path.current.style.fill = shapeColours[to.colour];
        }
        const t = Math.min(1, (elapsed - HOLD_MS) / MELT_MS);
        const k = ease(t);
        const a = ROUND[from.kind];
        const b = ROUND[to.kind];
        path.current?.setAttribute(
          'd',
          radial((angle) => a(angle) + (b(angle) - a(angle)) * k),
        );
        if (t === 1) {
          at = (at + 1) % steps.length;
          turned = false;
          started = now;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [steps]);

  return (
    <svg
      className={className ? `shape morph ${className}` : 'shape morph'}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}
      aria-hidden
    >
      <path ref={path} style={{ transition: `fill ${MELT_MS}ms ease` }} />
    </svg>
  );
}
