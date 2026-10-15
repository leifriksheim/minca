# Minca's design system

Every UI with Minca's name on it (the site, the app, the account home, the
Chrome extension) is built from what is in this folder. When something
looks different from one UI to the next, one of them is wrong.

The look in one line: **warm paper, navy ink, thin navy rules and flat shapes,
quiet enough that what people put in their spaces is the loudest thing on
screen.** Retro in the shapes and the type, clean everywhere else.

## Where it lives

| File               |                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `src/tokens.ts`    | Every colour, face, corner and shadow, as values and as `--minca-*` CSS custom properties        |
| `src/shapes.tsx`   | The shapes (`Shape`), the morph between them (`Morph`), and which shape each app has             |
| `src/Loader.tsx`   | The loader: five shapes hopping in turn, for anything on its way                                 |
| `src/Wordmark.tsx` | The mark (a four-band rainbow) and the wordmark; `src/mark.ts` has its bands for non-React pages |
| `src/styles.ts`    | Inline styles and base CSS for React UIs, built from the tokens                                  |

React UIs import the tokens and styles. Stylesheets use the custom
properties: `baseCss` puts them on `:root`, and a page without it injects
`tokenCss` itself. Never copy a hex value into a UI; add a token instead.

Reach for the pieces in `styles.ts` before writing your own, so the same
thing looks the same everywhere: `tile` (a card on the page), `frame` (a big
frame), `float` (a menu, popover or panel over the page), `chip` and
`chipOn`, `input` (one line, a pill) and `textarea` (many), `note`,
`smallButton` (secondary), `button` and `darkSmall` (the one thing to do),
`segmented`, `row`, `modal`. `baseCss` gives every page `.page` and
`.space-layout`. A component that needs something none of these is adds it
there, not beside itself.

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

- **Every corner is round, on one scale** (`radius`): `sm` for tags and code
  chips, `md` for rows, inputs and cards inside a surface, `lg` for surfaces
  (cards, panels, menus, dialogs), `xl` for the big frames on a page. Nothing
  is square, and nothing picks a size off the scale.
- **Controls are pills**: buttons, inputs that ask for one line, segmented
  controls, chips, the nav.
- **One line for edges.** The navy rule (`surface.rule`), one pixel, draws the
  edge of anything that stands on the page: a card, a frame, the nav, a
  secondary button, the footer. **Hairlines** (`surface.line`) only separate
  things _inside_ a surface, like rows in a list.
- **Ruled grids** set things side by side: cells share navy rules, with no
  gaps, inside one rounded frame. A cell may carry a small italic number
  (`01`, `v2`).
- **Shadows are soft and rare.** Only what floats over the page (a menu, a
  dialog, a popover) has one (`shadow.float`, `shadow.small`). Nothing blurs
  what is behind it.

## Pattern

The look is 70s print, kept clean: flat colour on paper, and room around it.

- **Grid paper**: a faint `surface.line` grid behind a hero or a frame, fading
  out at its edges. Never behind text that has to be read at length.
- **The rainbow**: the mark's four bands, as big arcs rising from the edge of
  a panel. Once per page.
- Patterns sit behind content, never inside a card, and never more than one
  per screen.

## Shapes

The shapes are the brand. A space is a grid, and each tool in it is a shape.

- Each built-in app has its own (`APP_SHAPES`): Chat a scallop, Polls a wave,
  Decisions a burst, Events a flower, Kanban a checker, Marketplace a leaf,
  Calls an arch. Use `shapeFor(id)`; it gives anything else (an app a group
  made, a space) a round shape picked by its id, so it is always the same one.
- A shape stands alone, flat, in one colour. No outlines, gradients, shadows or
  icons drawn inside it, except a number or a letter in its middle.
- A few shapes mean something, built from the same pieces (pills, arcs,
  dots, half circles), still flat and in one colour: `eyeShut` (nobody
  watching), `group` (people deciding together), `lock` (private) and
  `signal` (works without a connection); and for the protocol's ideas, `key`
  (an account), `grid` (a space), `stack` (signed versions), `shield` (who
  may do what), `tick` (checked everywhere), `pass` (an app's access) and
  `mesh` (nodes). Use them beside the point they
  stand for; add another the same way when a point needs one.
- `Morph` melts one round shape into the next. Use it where the point is that
  something can become anything, and only once per screen.
- Use shapes for identity (an app, a space), for empty states, and for marking
  points in a list. Not as decoration for its own sake.

## Motion

- **Loading is five shapes hopping in turn** (`Loader`), never a spinner and
  never "Loading…" alone. Give it a `label` that says what is on its way;
  `showLabel` puts the words beside the shapes. Where nothing is loading,
  `decorative` keeps the row as ornament, as the site's closing call does.

Small and calm. Shapes may turn a little on hover; controls only change
colour, they don't move.

A button's look is its inline style; its hover is its `data-variant`
(`hoverCss`). They are separate, so give each button the pair that match:
`primary` with `button` or `darkSmall`, `quiet` with `smallButton`, `danger`
with `smallButton` in `accent.danger`, `ghost` with `linkButton`. A white
button marked `primary` turns cobalt only under the pointer. Demos play on their own, and stop under
`prefers-reduced-motion`, where they show their final state.

## Words

Write for the people in a community, not for developers: short, plain
sentences that say what something does for them. No labels above headings, no
jargon (records, peers, keys) where an everyday word will do, and nothing that
goes stale as the product changes.
