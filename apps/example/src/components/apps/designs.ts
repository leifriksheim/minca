/**
 * Looks to ask an agent for when it makes an app. Every one keeps what makes
 * a screen at home in Minca (warm paper, navy ink, hairlines, whitespace,
 * restraint), and then leans a way of its own. The words go into the prompt
 * `CreateApp` copies; a screen can load no fonts or images (`SCREEN_GUIDE`),
 * so everything here is CSS the agent can write inline.
 */

import { accent, display, ink, surface } from '@minca/app-shared/tokens';

/** What every look shares, so a new app sits well beside Minca's own */
const BASE =
  `Make its screen look at home in the Minca app it opens in: a warm paper page (${surface.page}, never white), ` +
  `navy text (${ink.strong} for headings, ${ink.body} for body, ${ink.muted} for anything secondary), ` +
  `1px hairline borders (${surface.line}) instead of shadows, and nothing blurred: no soft drop shadows or gradients. ` +
  'Use the system font stack (-apple-system, "Segoe UI", system-ui, sans-serif), 14px body text, spacing on a 4px grid, and plenty of room. ' +
  'Buttons and inputs are real elements, at least 36px tall, with a visible focus ring. Only one accent colour, used for the main action and what is selected.';

export interface Design {
  readonly id: string;
  readonly label: string;
  /** For the picker: the feel in a few words */
  readonly blurb: string;
  /** For the picker's swatch */
  readonly swatch: {
    readonly accent: string;
    readonly radius: number;
    readonly font: string;
    readonly weight: number;
  };
  /** What it adds to the prompt, after BASE */
  readonly ask: string;
}

export const DESIGNS: ReadonlyArray<Design> = [
  {
    id: 'neutral',
    label: 'Neutral',
    blurb: 'Like Minca itself',
    swatch: { accent: accent.base, radius: 0, font: display, weight: 700 },
    ask:
      `Keep it like Minca itself: cobalt (${accent.base}) is the accent, for the main action and what is selected, and turns navy (${accent.hover}) on hover. ` +
      `Cards and panels have square corners, sit on the page in ${surface.card} and are separated by hairlines; ` +
      'buttons, chips and toggles are pills (border-radius: 999px). ' +
      `Headings are bold (700) with tight letter spacing (-0.04em) in "Bricolage Grotesque", falling back to the system sans, in ${ink.strong}. ` +
      'No decoration beyond that.',
  },
  {
    id: 'friendly',
    label: 'Friendly',
    blurb: 'Warm and soft',
    swatch: { accent: '#e8705a', radius: 12, font: 'inherit', weight: 600 },
    ask:
      'Make it warm and friendly: a soft coral accent (#e8705a), 12px rounded corners, gentle tinted backgrounds for highlights, ' +
      'short friendly labels, and an emoji where it truly helps, never more than one per section.',
  },
  {
    id: 'playful',
    label: 'Playful',
    blurb: 'Fun, a little quirky',
    swatch: { accent: '#7c3aed', radius: 16, font: 'inherit', weight: 800 },
    ask:
      'Make it playful and a little quirky: a bright violet accent (#7c3aed), chunky 14–16px corners, bold heavy headings, ' +
      'and small touches of delight: a springy transition on press, a sticker-like badge, a cheerful empty state. ' +
      'It must still be easy to read and use; delight goes in the details, not in the way.',
  },
  {
    id: 'professional',
    label: 'Professional',
    blurb: 'Calm and precise',
    swatch: { accent: '#335c99', radius: 4, font: 'inherit', weight: 500 },
    ask:
      'Make it calm and professional: dense but orderly, aligned columns and tabular numbers (font-variant-numeric: tabular-nums), ' +
      '4–6px corners, a muted blue accent (#335c99) used sparingly, small uppercase labels with letter spacing, and no emoji.',
  },
  {
    id: 'editorial',
    label: 'Editorial',
    blurb: 'Big type, lots of air',
    swatch: { accent: '#7a1f2b', radius: 2, font: 'Georgia, "Iowan Old Style", serif', weight: 600 },
    ask:
      'Make it editorial: large confident headings in a serif (Georgia, "Iowan Old Style", serif) with tight letter spacing, ' +
      'body text in the system sans, generous whitespace, near-square 2px corners, and a deep oxblood accent (#7a1f2b).',
  },
];

/** The sentences a look adds to the prompt */
export const designPrompt = (design: Design): string => `${BASE} ${design.ask}`;
