# Minca's design system

Every UI with Minca's name on it (the site, the app, the account home, the
Chrome extension, an app's screen) is built from what is in this folder and
the React components on top of it in `apps/shared`. When something looks
different from one UI to the next, one of them is wrong.

The look in one line: **warm paper, navy ink, thin navy rules and flat shapes,
quiet enough that what people put in their spaces is the loudest thing on
screen.** Retro in the shapes and the type, clean everywhere else.

## Where it lives

**`css/minca.css` is the look**, and the one stylesheet every UI loads: the
apps and the site import it, and the kit writes it into every app's screen.
`reference.html` shows every piece; open it after changing anything here.

| File               |                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `css/tokens.css`   | The palette, and the names everything reads: `--color-*`, `--space-*`, `--text-*`, `--radius-*`         |
| `css/base.css`     | The page and its text                                                                                   |
| `css/layout.css`   | `main`, `header`, `section`, `.row`, `.stack`, `.grid`, `.lanes`                                        |
| `css/controls.css` | Buttons by `data-intent`, fields, switches, tabs                                                        |
| `css/content.css`  | `article`, lists, `figure`, a month, `.tag`, `aside`, `.empty`, `data-tone`, `data-hue`, `data-actions` |
| `css/overlay.css`  | `dialog`, `menu`                                                                                        |
| `css/kit.css`      | The kit's own parts, which only its components use                                                      |
| `src/shapes.ts`    | The shapes' paths, and which shape each app and space has                                               |
| `src/round.ts`     | The round shapes as formulas, for the shapes, the avatar and the morph                                  |
| `src/avatar.ts`    | An account's avatar, two round shapes blended by its DID                                                |
| `src/frame/`       | The kit an app's screen draws with: Preact, people's faces, comments, places                            |

`src/tokens.ts` and `apps/shared/src/styles.ts` are the old way, inline styles
from values, and go as the apps move onto `css/`.

## The rules

- **Semantic HTML first.** An element is styled by what it is: `button`,
  `input`, `label`, `article`, `section`, `dialog`, `small`. A class only where
  HTML has no element for the role: `.row`, `.stack`, `.grid`, `.tag`,
  `.empty`, `.lanes`, `.truncate`.
- **Intent, never appearance.** Variants say why a thing is there:
  `data-intent="primary|quiet|danger|open"`, `data-tone="good|warn|danger"`,
  `data-hue="1"`…`"5"`, `data-gap="tight|loose"`. Nothing names a colour or a
  size, so a redesign changes `css/` and no markup.
- **No knobs.** One control height, three gaps, the headings' sizes and no
  other, no free colours. What a screen can't build from the pieces, the system
  gets, once, for everyone. `src/guide.ts` lists everything an agent may use;
  a piece is added there and in `reference.html` in the same change.
- **Tokens by purpose.** The palette (`--paper`, `--navy`, `--cobalt`…) is
  private to `tokens.css`. Everything else reads `--color-text`,
  `--color-action`, `--color-outline` and the rest.
- **One layer.** Everything sits in `@layer minca`, so a page's own CSS (an
  app's CSS modules) wins over it without `!important`.
- Only a game or a drawing styles itself, inside `<main data-wide>`, on the tokens.

## Colour

- **Page** is paper (`--color-page`), never white. Cards and fields sit on it
  in `--color-surface`; a band set back from the page is `--color-sunken`.
- **Text** is navy, in three strengths: `--color-text-strong` for headings and
  what must be read, `--color-text`, and `--color-text-muted` for what you skim.
- **Cobalt** (`--color-action`) is the one colour for acting: the main
  button, focus, the selected thing. It turns navy on hover.
- **The hues** (cobalt, coral, peach, sage, lilac, as `--color-hue-1`…`5`) are
  for shapes and for telling things apart, never for text. They take turns in
  that order. The one surface they colour is a tint mixed into the paper.
- **Good, warn and danger** are for state, sparingly: an error, a check that passed.

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
- **Things you press are pills**: buttons, tabs, toggles, tags, the nav.
  Fields to type or choose in (inputs, selects, text boxes) take the `md`
  corner, like a row.
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

## Colour tiles

Where a page offers a few things side by side (the platforms to download,
the steps to install, a panel that sells one idea), each sits on a colour
tile: one shape colour mixed into the paper, the navy rule round it, the `xl`
corner, and that colour's shape, big, half off one corner, turning a little
on hover.

- The ground is the colour at `--minca-tint-tile` (28%) for a tile, or
  `--minca-tint-panel` (14%) for a wide panel with words to read on it.
- Text on a tile is navy, as on the page. Never white, and never on solid
  colour: the front page's panel used to be cobalt, and is a tile now.
- One shape per tile, the same colour as its ground. Tiles side by side take
  different colours.
- The site has them as `.tile` (with a `.c-*` colour, `.tile-panel` for the
  wide kind and `.tile-art` on the shape) in `apps/site/src/pages/site.css`.

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

- Each ready-made app has a shape that says what it is for (`APP_SHAPES`):
  Chat a speech bubble, Polls bars, Events a calendar, Kanban columns of
  cards, Marketplace a price tag, Files a folder, Lists a tick, Bills a
  receipt, and a chat for two a lock. Use `shapeFor(id)`; it gives anything else (an app a group
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
- An account's avatar is a shape too: two round shapes melted together at a
  point its DID picks, on a ground (`Avatar`). It is how people tell accounts
  apart before reading a name, so use it wherever an account appears.
- Use shapes for identity (an app, a space, an account), for empty states, and
  for marking points in a list. Not as decoration for its own sake.
- Points in a list are marked with these shapes, never with line icons: on
  the site, `Marked` (`apps/site/src/pages/Site.tsx`) sets them in a ruled grid.

## Motion

- **Loading is five shapes hopping in turn** (`Loader`), never a spinner and
  never "Loading…" alone. Give it a `label` that says what is on its way;
  `showLabel` puts the words beside the shapes. Where nothing is loading,
  `decorative` keeps the row as ornament, as the site's closing call does.

Small and calm. Shapes may turn a little on hover; controls only change
colour, they don't move.

Demos play on their own, and stop under
`prefers-reduced-motion`, where they show their final state.

## Words

Write for the people in a community, not for developers: short, plain
sentences that say what something does for them. No labels above headings, no
jargon (records, peers, keys) where an everyday word will do, and nothing that
goes stale as the product changes.
