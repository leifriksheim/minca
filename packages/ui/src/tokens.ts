/**
 * The colours JavaScript itself draws with: shapes, avatars, a tab's dot, the
 * extension's badge. Everything else reads the custom properties in
 * css/tokens.css, which hold the same values; keep the two in step.
 */

/** The shapes' colours. Use them for shapes and marks, not for text or surfaces. */
export const shapeColours = {
  cobalt: '#2340d6',
  coral: '#ff6b4a',
  peach: '#ffc46b',
  sage: '#4e8f6c',
  lilac: '#f0c3ef',
  /** For a shape cut out of another */
  paper: '#f6f3ee',
  ink: '#13214a',
} as const;

export type ShapeColour = keyof typeof shapeColours;

/** Each shape colour mixed into paper, for a ground a shape sits on (an avatar's) */
export const shapeGrounds = {
  cobalt: '#dfe3f7',
  coral: '#fde0d6',
  peach: '#fcecd0',
  sage: '#dce9df',
  lilac: '#f6e3f2',
} as const;

/** The five that take turns, in order */
export const SHAPE_CYCLE: readonly ShapeColour[] = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/** State, for what is drawn outside a page: a badge, a dot on the tab's icon */
export const state = {
  ink: '#13214a',
  paper: '#f6f3ee',
  good: '#2f7a52',
  warn: '#9a5a0b',
  danger: '#c8361f',
} as const;
