# Minca's design system

Every UI with Minca's name on it (the site, the app, the account home, Liquid,
the Chrome extension) is built from what is in this folder. When something
looks different from one UI to the next, one of them is wrong.

The look in one line: **warm paper, navy ink, thin navy rules and flat shapes,
quiet enough that what people put in their spaces is the loudest thing on
screen.** Retro in the shapes and the type, clean everywhere else.

## Where it lives

| File               |                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `src/tokens.ts`    | Every colour, face, corner and shadow, as values and as `--minca-*` CSS custom properties        |
| `src/shapes.tsx`   | The shapes (`Shape`), the morph between them (`Morph`), and which shape each app has             |
| `src/Wordmark.tsx` | The mark (a four-band rainbow) and the wordmark; `src/mark.ts` has its bands for non-React pages |
| `src/styles.ts`    | Inline styles and base CSS for React UIs, built from the tokens                                  |

React UIs import the tokens and styles. Stylesheets use the custom
properties: `baseCss` puts them on `:root`, and a page without it injects
`tokenCss` itself. Never copy a hex value into a UI; add a token instead.

## Colour

- **Page** is paper (`surface.page`), never white. Cards and inputs sit on it in
  `surface.card`; a band set back from the page is `surface.sunken`.
- **Ink** is navy, in four strengths: `strong` for headings and what must be
  read, `body`, `muted` for the things you skim, `faint` for timestamps and ids.
- **Cobalt** (`accent.base`) is the one colour for actions: the primary
  button, focus, the selected thing. It turns navy on hover.
- **The shape colours** (cobalt, coral, peach, sage, lilac) are for shapes and
  marks only, never for text or surfaces. They take turns in that order.
- **Danger and good** are for state, sparingly: an error, a check that passed.

## Type

- **Bricolage Grotesque** (`display`) for page titles, section headings, dialog
  titles and the wordmark: weight 700, tight tracking (`-0.04em`).
- **Geist** (`font`) for everything else, **Geist Mono** (`mono`) for code and ids.
- `FONTS_HREF` is the stylesheet that loads all three; every web page links it.
  The extension bundles its own copies instead (`apps/extension/static/fonts/`),
  so it never calls Google when the popup opens.

## Shape and line

- **Surfaces have square corners**: cards, panels, dialogs, menus, frames.
  `radius.sm` (3px) is only for small things like tags and code chips.
- **Controls are pills**: buttons, segmented controls, chips, the nav.
- **Hairlines** (`surface.line`) separate things inside dense UI. **The navy
  rule** (`surface.rule`) is for what should read as drawn: grids of cells,
  the frame of a dialog or a menu.
- **Ruled grids** set things side by side: cells share navy rules, with no
  gaps and no rounding. A cell may carry a small italic number (`01`, `v2`).
- **Nothing blurs.** Anything that floats (a menu, a dialog, a popover) has a
  navy frame and a flat, offset shadow (`shadow.float`, `shadow.small`).

## Shapes

The shapes are the brand. A space is a grid, and each tool in it is a shape.

- Each built-in app has its own (`APP_SHAPES`): Chat a scallop, Polls a wave,
  Decisions a burst, Events a flower, Kanban a checker, Marketplace a leaf,
  Calls an arch. Use `shapeFor(id)`; it gives anything else (an app a group
  made, a space) a round shape picked by its id, so it is always the same one.
- A shape stands alone, flat, in one colour. No outlines, gradients, shadows or
  icons drawn inside it, except a number or a letter in its middle.
- `Morph` melts one round shape into the next. Use it where the point is that
  something can become anything, and only once per screen.
- Use shapes for identity (an app, a space), for empty states, and for marking
  points in a list. Not as decoration for its own sake.

## Motion

Small and springy: a shape turns a little on hover, a button lifts a pixel.
Everything that moves on its own stops under `prefers-reduced-motion`.

## Words

Write for the people in a community, not for developers: short, plain
sentences that say what something does for them. No labels above headings, no
jargon (records, peers, keys) where an everyday word will do, and nothing that
goes stale as the product changes.
