import { useEffect, useRef, type CSSProperties } from 'react';
import { shapeColours, type ShapeColour } from './tokens';

/**
 * Minca's shapes. A space is a grid, and every tool in it is a shape: flat,
 * round, a little odd, and different from its neighbours. They are drawn
 * here from formulas rather than shipped as files, on a 100 × 100 canvas.
 *
 * The round ones are each a radius for every angle, so any two can melt into
 * each other: `Morph` blends one into the next.
 *
 * Shared by every UI (DESIGN.md beside this file says where each is used).
 * Give a shape a `colour` from the tokens, or leave it out and it fills with
 * the CSS custom property `--c`, as the site's colour classes set it.
 */

type Radius = (angle: number) => number;

/** How far round from one tip to the next, 1 at a tip and 0 halfway between */
const tip = (angle: number, tips: number) => {
  const x = (((angle + Math.PI / 2) / (Math.PI * 2)) * tips) % 1;
  return Math.abs(x - 0.5) * 2;
};

/** The shapes that can turn into each other */
const ROUND = {
  /** A circle with a scalloped edge */
  scallop: (a) => 40 + 8 * Math.abs(Math.sin(7 * a)),
  /** Eight round petals */
  flower: (a) => 16 + 32 * Math.abs(Math.cos(4 * a)) ** 0.6,
  /** Twelve thin petals */
  daisy: (a) => 8 + 40 * Math.abs(Math.cos(6 * a)) ** 2.2,
  /** Four fat lobes */
  clover: (a) => 26 + 22 * Math.abs(Math.cos(2 * a)) ** 0.5,
  /** A many-pointed seal */
  burst: (a) => 36 + 12 * tip(a, 14),
  /** An eight-pointed star */
  star: (a) => 18 + 30 * tip(a, 8) ** 1.4,
  /** A four-pointed twinkle with curved sides */
  sparkle: (a) => 10 + 38 * Math.abs(Math.cos(2 * a)) ** 8,
  /** A square with soft corners */
  squircle: (a) => 44 / (Math.abs(Math.cos(a)) ** 4 + Math.abs(Math.sin(a)) ** 4) ** 0.25,
} as const satisfies Record<string, Radius>;

export type RoundKind = keyof typeof ROUND;

const STEPS = 240;

/** A closed outline whose distance from the centre follows `radius(angle)` */
function radial(radius: Radius): string {
  let d = '';
  for (let i = 0; i < STEPS; i++) {
    const angle = (i / STEPS) * Math.PI * 2;
    const r = radius(angle);
    d += `${i === 0 ? 'M' : 'L'}${(50 + r * Math.cos(angle)).toFixed(2)} ${(50 + r * Math.sin(angle)).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** A band whose two sides wave, top to bottom */
function wave(): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const y = 4 + (i / 60) * 92;
    const dx = 9 * Math.sin((i / 60) * Math.PI * 3);
    left.push(`${(30 + dx).toFixed(2)} ${y.toFixed(2)}`);
    right.unshift(`${(70 + dx).toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${left.join('L')}L${right.join('L')}Z`;
}

const PATHS = {
  scallop: radial(ROUND.scallop),
  flower: radial(ROUND.flower),
  daisy: radial(ROUND.daisy),
  clover: radial(ROUND.clover),
  burst: radial(ROUND.burst),
  star: radial(ROUND.star),
  sparkle: radial(ROUND.sparkle),
  squircle: radial(ROUND.squircle),
  /** Half a circle, lying flat */
  half: 'M2 76A48 48 0 0 1 98 76Z',
  /** Two opposite corners rounded */
  leaf: 'M50 2H98V50A48 48 0 0 1 50 98H2V50A48 48 0 0 1 50 2Z',
  /** Half a ring */
  arch: 'M4 82A46 46 0 0 1 96 82H72A22 22 0 0 0 28 82Z',
  /** A band with wavy sides */
  wave: wave(),
  /** Five squares in an X */
  checker: 'M4 4h30v30H4zM66 4h30v30H66zM35 35h30v30H35zM4 66h30v30H4zM66 66h30v30H66z',
  /** Three dots in a row */
  dots: 'M4 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0M35 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0M66 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0',
} as const;

export type ShapeKind = keyof typeof PATHS;

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
 * draws straight onto the path each frame, so React renders it once; `onTurn`
 * says which step it is melting into, for anything that should change with it.
 */
export function Morph({
  steps,
  size,
  className,
  onTurn,
}: {
  steps: ReadonlyArray<{ kind: RoundKind; colour: ShapeColour }>;
  size?: number;
  className?: string;
  onTurn?: (index: number) => void;
}) {
  const path = useRef<SVGPathElement>(null);
  const turn = useRef(onTurn);
  useEffect(() => {
    turn.current = onTurn;
  }, [onTurn]);

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
          turn.current?.((at + 1) % steps.length);
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

/** Each built-in app's shape and colour, the same on the site as in the app */
export const APP_SHAPES: Readonly<Record<string, { kind: ShapeKind; colour: ShapeColour }>> = {
  chat: { kind: 'scallop', colour: 'cobalt' },
  polls: { kind: 'wave', colour: 'coral' },
  decisions: { kind: 'burst', colour: 'peach' },
  events: { kind: 'flower', colour: 'sage' },
  kanban: { kind: 'checker', colour: 'lilac' },
  marketplace: { kind: 'leaf', colour: 'cobalt' },
  calls: { kind: 'arch', colour: 'coral' },
};

const ROUND_KINDS: readonly RoundKind[] = [
  'scallop',
  'flower',
  'daisy',
  'clover',
  'burst',
  'star',
  'sparkle',
  'squircle',
];
const CYCLE: readonly ShapeColour[] = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/**
 * The shape for anything with an id: a built-in app's own, or, for an app a
 * group made or a space, one of the round shapes picked by the id, so the same
 * thing always gets the same shape.
 */
export function shapeFor(id: string): { kind: ShapeKind; colour: ShapeColour } {
  const known = APP_SHAPES[id];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const n = Math.abs(hash);
  return {
    kind: ROUND_KINDS[n % ROUND_KINDS.length] ?? 'scallop',
    colour: CYCLE[Math.floor(n / ROUND_KINDS.length) % CYCLE.length] ?? 'cobalt',
  };
}
