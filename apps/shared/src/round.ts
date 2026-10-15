/**
 * The round shapes as formulas, each a radius for every angle on a 100 × 100
 * canvas. Plain data, so pages without React (the extension) draw them the
 * same way `shapes.tsx` does, and any two can melt into each other.
 */

export type Radius = (angle: number) => number;

/** How far round from one tip to the next, 1 at a tip and 0 halfway between */
const tip = (angle: number, tips: number) => {
  const x = (((angle + Math.PI / 2) / (Math.PI * 2)) * tips) % 1;
  return Math.abs(x - 0.5) * 2;
};

/** The shapes that can turn into each other */
export const ROUND = {
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

export const ROUND_KINDS: readonly RoundKind[] = [
  'scallop',
  'flower',
  'daisy',
  'clover',
  'burst',
  'star',
  'sparkle',
  'squircle',
];

/** A closed outline whose distance from the centre follows `radius(angle)`, in `steps` points */
export function radial(radius: Radius, steps = 240): string {
  let d = '';
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const r = radius(angle);
    d += `${i === 0 ? 'M' : 'L'}${(50 + r * Math.cos(angle)).toFixed(2)} ${(50 + r * Math.sin(angle)).toFixed(2)}`;
  }
  return `${d}Z`;
}
