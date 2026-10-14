/**
 * Minca's design tokens: the one place every UI takes its colours, type and
 * corners from. The site, the app, the account home, Liquid and the extension
 * all read these, either as values (inline styles) or as the CSS custom
 * properties in {@link tokenCss}. DESIGN.md beside this file says how to use
 * them.
 *
 * Paper, navy ink and thin navy rules; colour comes from the shapes. Surfaces
 * have square corners, controls are pills.
 */

export const ink = {
  /** Headings and anything that must be read first */
  strong: '#13214a',
  /** Body text */
  body: '#2a3352',
  /** Supporting text: metadata, hints, the things you skim */
  muted: '#5d6480',
  /** Barely there: timestamps, ids */
  faint: '#8c90a3',
  /** Text on cobalt or navy */
  inverse: '#ffffff',
} as const;

export const surface = {
  /** The page: warm paper, never white */
  page: '#f6f3ee',
  /** What sits on the page: cards, inputs, menus */
  card: '#fffdf9',
  /** A band set back from the page, and the hover on a row */
  sunken: '#efe9df',
  /** Hairlines inside dense UI */
  line: '#e2dcd0',
  lineStrong: '#cbc3b3',
  /** The navy rule: grids, frames, anything that should read as drawn */
  rule: '#13214a',
  /** Dims the page behind a dialog */
  scrim: 'rgba(19, 33, 74, .35)',
} as const;

export const accent = {
  /** The one accent for actions: cobalt */
  base: '#2340d6',
  /** What a primary action turns on hover */
  hover: '#13214a',
  soft: '#e6eafb',
  danger: '#c8361f',
  dangerSoft: '#fdebe6',
  good: '#2f7a52',
  goodSoft: '#e3f0e8',
  warn: '#9a5a0b',
  warnSoft: '#fbefd9',
} as const;

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

/** The five that take turns, in order */
export const SHAPE_CYCLE: readonly ShapeColour[] = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/** Square surfaces, pill controls; `sm` is for the little things, like a tag or a code chip */
export const radius = { none: 0, sm: 3, md: 3, lg: 0, pill: 999 } as const;

/** Bricolage Grotesque for headings and the wordmark, Geist for everything else */
export const font =
  '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const display = '"Bricolage Grotesque", "Geist", -apple-system, BlinkMacSystemFont, sans-serif';
export const mono = '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** The stylesheet every page loads for those faces (Google Fonts) */
export const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap';

/** Floating things (menus, dialogs) cast a hard, flat shadow, not a blur */
export const shadow = {
  float: `4px 4px 0 ${surface.rule}`,
  small: `2px 2px 0 ${surface.rule}`,
} as const;

/** The tokens as CSS custom properties, for stylesheets: `var(--minca-ink)` and so on */
export const tokenCss = `
  :root {
    --minca-ink: ${ink.strong};
    --minca-body: ${ink.body};
    --minca-muted: ${ink.muted};
    --minca-faint: ${ink.faint};
    --minca-page: ${surface.page};
    --minca-card: ${surface.card};
    --minca-sunken: ${surface.sunken};
    --minca-line: ${surface.line};
    --minca-line-strong: ${surface.lineStrong};
    --minca-rule: ${surface.rule};
    --minca-accent: ${accent.base};
    --minca-accent-hover: ${accent.hover};
    --minca-accent-soft: ${accent.soft};
    --minca-danger: ${accent.danger};
    --minca-danger-soft: ${accent.dangerSoft};
    --minca-good: ${accent.good};
    --minca-good-soft: ${accent.goodSoft};
    --minca-warn: ${accent.warn};
    --minca-cobalt: ${shapeColours.cobalt};
    --minca-coral: ${shapeColours.coral};
    --minca-peach: ${shapeColours.peach};
    --minca-sage: ${shapeColours.sage};
    --minca-lilac: ${shapeColours.lilac};
    --minca-font: ${font};
    --minca-display: ${display};
    --minca-mono: ${mono};
    --minca-shadow: ${shadow.float};
    --minca-shadow-small: ${shadow.small};
  }
`;
