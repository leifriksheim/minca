import type { CSSProperties } from 'react';

import {
  accent,
  display,
  font,
  ink,
  mono,
  radius,
  shadow,
  shapeColours,
  surface,
  tokenCss,
} from '@minca/ui/tokens';

/**
 * One visual vocabulary for the example app and the account home,
 * built from Minca's tokens (`@minca/ui/tokens`; `packages/ui/DESIGN.md` says how to use them).
 *
 * Warm paper, navy ink, cobalt for the thing to do. What stands on the page
 * (a card, a frame, the nav, a secondary button) has round corners and the
 * navy rule; hairlines only separate things inside a surface; controls are
 * pills; only what floats casts a soft navy shadow. The landing page
 * (`apps/site`) draws the same pieces. Colour beyond that comes from the shapes (`shapes.tsx`), never
 * from the chrome, so nothing competes with what people put in their spaces.
 *
 * Inline styles cannot express hover, focus or placeholders, so those live in
 * {@link baseCss} and {@link hoverCss}, which each app puts in its own
 * stylesheet next to its layout rules.
 */

/** Resets and the states every control shares, with the tokens as CSS custom properties. */
export const baseCss = `
    ${tokenCss}
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: ${surface.page};
      color: ${ink.body};
      font-family: ${font};
      font-size: 14px;
      letter-spacing: -0.006em;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    h1, h2, h3, p, ul, figure { margin: 0; }
    h1, h2 { font-family: ${display}; font-weight: 700; letter-spacing: -0.04em; color: ${ink.strong}; }
    ul { padding: 0; }

    button { font-family: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
    button:not(:disabled) { cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }

    input, textarea, select { font-family: inherit; transition: border-color .15s ease, box-shadow .15s ease; }
    input::placeholder, textarea::placeholder { color: ${ink.faint}; }
    /* WebKit (Safari, the desktop shell) draws its own select and ignores our border and fill, so every select draws its chevron. */
    select:not([multiple]) { -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235d6480' stroke-width='1.5'/%3E%3C/svg%3E") !important; background-repeat: no-repeat !important; background-position: right 12px center !important; padding-right: 30px !important; cursor: pointer; }
    /* No text field under 16px on a touchscreen, or iOS zooms the page every
       time one is tapped. Only the small ones are raised: a field drawn large,
       like a record's title, keeps its size. */
    @media (pointer: coarse) {
      :is(input:not([type="checkbox"]):not([type="radio"]), textarea, select):is(:not([style*="font-size"]), [style*="font-size: 9"], [style*="font-size: 10"], [style*="font-size: 11"], [style*="font-size: 12"], [style*="font-size: 13"], [style*="font-size: 14"], [style*="font-size: 15"]) { font-size: 16px !important; }
    }
    input:focus, textarea:focus, select:focus { border-color: ${accent.base} !important; box-shadow: 0 0 0 3px ${accent.soft}; outline: none; }
    [data-variant="quiet"], [data-variant="secondary"] { border: 1px solid ${surface.rule} !important; }
    tbody tr { transition: background-color .12s ease; }

    /* Visible only for keyboard users, so a mouse click stays quiet. */
    :focus-visible { outline: 2px solid ${accent.base}; outline-offset: 2px; }
    button:focus:not(:focus-visible) { outline: none; }

    summary { cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: '›'; float: right; transition: transform .15s ease; display: inline-block; }
    details[open] > summary::after { transform: rotate(90deg); }

    [data-row-action] { transition: opacity .12s ease; }

    @keyframes minca-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes minca-slide { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: none } }
    [data-editable]:focus { border-color: ${surface.lineStrong} !important; background: ${surface.card} !important; box-shadow: none !important; }
    .inline-field select, .inline-field input { height: 32px !important; border-color: transparent !important; background-color: transparent !important; margin-left: -8px; padding-left: 8px !important; width: calc(100% + 8px) !important; }
    .inline-field select:focus, .inline-field input:focus { border-color: ${surface.lineStrong} !important; background-color: ${surface.card} !important; box-shadow: none !important; }
    [data-tile] { transition: border-color .15s ease, background-color .15s ease; }
    @keyframes minca-rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
    /* A dialog taller than the window scrolls, and what is in it keeps its size rather than squashing. */
    .modal { max-height: calc(100dvh - 40px); overflow-y: auto; }
    .modal > * { flex-shrink: 0; }

    code { font-family: ${mono}; }

    /* The page a screen sits on: a column in the middle, room above and below. */
    .page { min-height: 100vh; min-height: 100dvh; display: flex; justify-content: center; align-items: flex-start; padding: 56px 20px 80px; }

    /* A side column beside what it opens; one column on a narrow screen. */
    .space-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; align-items: start; }
    @media (max-width: 760px) { .space-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; } }

    /* A pill holding an input and words beside it: the ring goes round the pill, not the input. */
    .pill-field input, .pill-field input:focus { border: none !important; box-shadow: none !important; }
    .pill-field:focus-within { border-color: ${accent.base} !important; box-shadow: 0 0 0 3px ${accent.soft}; }

    /* A list row is a target, not a card: its small actions show with the
       hover, where there is a pointer that hovers. On touch they stay visible,
       and keyboard users reach them by focus. */
    @media (hover: hover) {
      [data-row-action] { opacity: 0; }
      [data-row-action]:focus-visible { opacity: 1; }
    }
`;

/**
 * What changes under a pointer. Each app decides where it applies: the
 * example only where the pointer can hover, so a tap on a touchscreen does not
 * leave a hover look stuck.
 */
export const hoverCss = `
    /* Controls only change colour: nothing moves, nothing lifts. Each rule sets
       the text colour as well as the fill, so the hover reads whatever the
       button looked like before it. */
    [data-variant="primary"]:not(:disabled):hover { background-color: ${accent.hover} !important; border-color: ${accent.hover} !important; color: ${ink.inverse} !important; }
    [data-variant="quiet"]:not(:disabled):hover { background-color: ${surface.sunken} !important; color: ${ink.strong} !important; }
    [data-variant="ghost"]:not(:disabled):hover { color: ${ink.strong} !important; }
    [data-variant="danger"]:not(:disabled):hover { background-color: ${accent.dangerSoft} !important; color: ${accent.danger} !important; }

    tbody tr:hover { background-color: ${surface.sunken}; }
    button[style*="text-align: left"]:not(:disabled):hover { border-color: ${surface.lineStrong} !important; }
    summary:hover { color: ${ink.strong}; }
    [data-row]:hover { background-color: ${surface.sunken} !important; }
    [data-menu-item]:not(:disabled):hover { background-color: ${surface.sunken} !important; color: ${ink.strong} !important; }
    [data-row]:hover [data-row-action] { opacity: 1; }
    [data-editable]:hover { border-color: ${surface.line} !important; background: ${surface.sunken} !important; }
    .inline-field select:hover, .inline-field input:hover { border-color: ${surface.line} !important; background-color: ${surface.sunken} !important; }
    [data-nav]:not([aria-current]):hover { background: ${surface.sunken} !important; }
    [data-tile]:hover { background-color: ${surface.sunken} !important; }
    [data-tile]:hover [data-row-action] { opacity: 1; }
    [data-tile-new]:hover { border-color: ${ink.muted} !important; color: ${ink.strong} !important; background: ${surface.sunken} !important; }
    [data-rail-item]:not([aria-current]):hover [data-rail-pill] { height: 10px !important; opacity: 1 !important; }
    [data-rail-add]:hover > span { border-color: ${ink.muted} !important; color: ${ink.strong} !important; background: ${surface.card}; }
`;

const button: CSSProperties = {
  height: 40,
  padding: '0 16px',
  borderRadius: radius.pill,
  border: `1px solid ${accent.base}`,
  backgroundColor: accent.base,
  color: ink.inverse,
  fontSize: 14,
  fontWeight: 500,
  width: '100%',
};

const smallButton: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: radius.pill,
  border: `1px solid ${surface.rule}`,
  backgroundColor: surface.card,
  color: ink.strong,
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const segment: CSSProperties = {
  flex: 1,
  padding: '6px 14px',
  borderRadius: radius.pill,
  border: '1px solid transparent',
  background: 'none',
  color: ink.muted,
  fontSize: 13,
  fontWeight: 500,
};

const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 10px',
  borderRadius: radius.pill,
  border: `1px solid ${surface.line}`,
  backgroundColor: surface.sunken,
  color: ink.body,
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

/** A column of children `gap` pixels apart */
export const stack = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });

/** A row of children `gap` pixels apart */
export const hstack = (gap: number): CSSProperties => ({ display: 'flex', gap });

/** Shared inline styles — kept in one place so the app has a single visual vocabulary. */
export const styles = {
  /** Onboarding is a column on the page, not a box: a sign-in, not a dialog. */
  card: {
    padding: '64px 0 0',
    maxWidth: 380,
    width: '100%',
  },
  title: {
    fontFamily: display,
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.04em',
    lineHeight: 1.05,
    color: ink.strong,
    marginBottom: 8,
  },
  subtitle: { fontSize: 15, color: ink.muted, marginBottom: 32, lineHeight: 1.5 },
  hint: { fontSize: 14, color: ink.muted, marginBottom: 20, lineHeight: 1.6 },

  form: stack(8),
  /** A field for one line: a pill, like every control. Many lines: {@link styles.textarea}. */
  input: {
    width: '100%',
    height: 40,
    padding: '0 16px',
    borderRadius: radius.pill,
    border: `1px solid ${surface.lineStrong}`,
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 14,
    outline: 'none',
  },
  /** A field for many lines: the corner of a row, since a pill can't hold a paragraph */
  textarea: {
    width: '100%',
    minHeight: 80,
    padding: '10px 12px',
    borderRadius: radius.md,
    border: `1px solid ${surface.lineStrong}`,
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 14,
    lineHeight: 1.5,
    outline: 'none',
    resize: 'vertical',
  },
  button,

  error: { color: accent.danger, fontSize: 14, fontWeight: 500 },
  errorBox: {
    marginTop: 16,
    padding: '14px 16px',
    borderRadius: radius.md,
    backgroundColor: accent.dangerSoft,
    border: `1px solid ${accent.danger}`,
  },
  /** A neutral aside, set back from the page. For errors, use errorBox. */
  note: {
    padding: '14px 16px',
    borderRadius: radius.md,
    backgroundColor: surface.sunken,
    fontSize: 13,
    color: ink.body,
    lineHeight: 1.6,
  },
  errorHint: { color: ink.muted, fontSize: 13, marginTop: 8, lineHeight: 1.6 },

  app: { maxWidth: 720, width: '100%' },
  headerRow: {
    marginBottom: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  appTitle: {
    fontFamily: display,
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: '-0.04em',
    color: ink.strong,
  },
  badge: {
    fontSize: 12,
    color: ink.muted,
    backgroundColor: surface.card,
    border: `1px solid ${surface.line}`,
    padding: '2px 8px',
    borderRadius: radius.pill,
  },

  addButton: { ...button, width: 'auto', whiteSpace: 'nowrap', alignSelf: 'flex-start' },
  /** Secondary actions: the card's white, the navy rule, a little shorter */
  smallButton,
  /** A small button in the one accent, for the one thing to do next */
  darkSmall: {
    ...smallButton,
    border: `1px solid ${accent.base}`,
    backgroundColor: accent.base,
    color: ink.inverse,
  },

  todoList: { listStyle: 'none', ...stack(8) },
  emptyState: {
    textAlign: 'center',
    color: ink.faint,
    fontSize: 14,
    padding: '36px 16px',
    border: `1px dashed ${surface.lineStrong}`,
    borderRadius: radius.md,
  },
  checkbox: { marginTop: 4, width: 15, height: 15, accentColor: accent.base, cursor: 'pointer' },
  todoContent: { flex: 1, minWidth: 0 },
  todoText: { fontSize: 14, fontWeight: 500, color: ink.strong, lineHeight: 1.5, wordBreak: 'break-word' },
  todoMeta: { fontSize: 12, color: ink.faint, marginTop: 3, lineHeight: 1.5 },

  panel: {
    marginTop: 16,
    border: `1px solid ${surface.rule}`,
    borderRadius: radius.lg,
    backgroundColor: surface.card,
    overflow: 'hidden',
  },
  panelSummary: {
    padding: '13px 16px',
    fontSize: 14,
    fontWeight: 500,
    color: ink.body,
    userSelect: 'none',
  },
  panelBody: {
    padding: '4px 16px 16px',
    fontSize: 13,
    color: ink.muted,
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  panelSection: {
    paddingTop: 20,
    marginTop: 8,
    borderTop: `1px solid ${surface.line}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    fontFamily: display,
    fontSize: 15,
    fontWeight: 700,
    color: ink.strong,
    letterSpacing: '-0.04em',
  },

  token: {
    display: 'block',
    marginTop: 8,
    padding: 12,
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    fontSize: 11,
    color: ink.muted,
    wordBreak: 'break-all',
    lineHeight: 1.5,
    maxHeight: 96,
    overflow: 'auto',
  },

  linkRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 10 },
  linkButton: {
    background: 'none',
    border: 'none',
    color: ink.muted,
    fontSize: 13,
    fontWeight: 500,
    padding: '6px 10px',
    borderRadius: radius.pill,
  },

  /** A band set back from the page: no edge, the colour says it */
  inviteBanner: {
    padding: '16px 18px',
    borderRadius: radius.lg,
    backgroundColor: surface.sunken,
    marginBottom: 16,
  },

  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 14,
    color: ink.body,
    cursor: 'pointer',
  },

  factLabel: { color: ink.muted, fontSize: 12 },
  factValue: { color: ink.strong, fontSize: 12, fontWeight: 500 },

  /** A small circled "i", sitting inline with the text it explains. */
  infoButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    padding: 0,
    marginLeft: 6,
    verticalAlign: 'text-bottom',
    borderRadius: radius.pill,
    border: `1px solid ${surface.lineStrong}`,
    background: 'none',
    color: ink.muted,
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
  },
  /** What the circled "i" opens. */
  popover: {
    position: 'absolute',
    zIndex: 30,
    top: 22,
    left: 0,
    width: 260,
    padding: '12px 14px',
    borderRadius: radius.md,
    backgroundColor: surface.card,
    border: `1px solid ${surface.rule}`,
    boxShadow: shadow.small,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: ink.muted,
    textAlign: 'left',
    fontWeight: 400,
    animation: 'minca-fade .1s ease',
  },

  /** Dims the page behind a modal, and centres it. */
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: surface.scrim,
    animation: 'minca-fade .12s ease',
  },
  modal: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: surface.card,
    borderRadius: radius.lg,
    border: `1px solid ${surface.rule}`,
    padding: '24px 22px',
    boxShadow: shadow.float,
    animation: 'minca-rise .16s ease',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  modalTitle: {
    fontFamily: display,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '-0.04em',
    color: ink.strong,
  },

  /** Choices side by side: a sunken track, the chosen one a card in it with the rule (the site's toggle). */
  segmented: {
    display: 'flex',
    padding: 4,
    gap: 2,
    backgroundColor: surface.sunken,
    borderRadius: radius.pill,
  },
  segment,
  segmentActive: {
    ...segment,
    border: `1px solid ${surface.rule}`,
    background: surface.card,
    color: ink.strong,
  },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: ink.muted, marginBottom: 6 },

  /** A row in a list: a target, with no border until you are over it. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderRadius: radius.md,
    border: '1px solid transparent',
    background: 'none',
    width: '100%',
    textAlign: 'left',
  },
  rowAction: {
    border: 'none',
    background: 'none',
    color: ink.faint,
    fontSize: 15,
    lineHeight: 1,
    padding: '4px 8px',
    borderRadius: radius.pill,
    flexShrink: 0,
  },

  /**
   * A card that stands on the page: the navy rule, the surface corner. What
   * every list of spaces, apps, rules and settings is made of; spread it and
   * add padding. A tile you can pick also gets `data-tile` for its hover.
   */
  tile: {
    border: `1px solid ${surface.rule}`,
    borderRadius: radius.lg,
    backgroundColor: surface.card,
  },
  /** A tag or a filter: a small sunken pill with a hairline, as the site's chips are */
  chip,
  /** A chip that is chosen: the rule, as a chosen segment has */
  chipOn: { ...chip, border: `1px solid ${surface.rule}`, backgroundColor: surface.card, color: ink.strong },
  /** Anything that floats over the page (a menu, a popover, a panel): the rule, a soft shadow */
  float: {
    border: `1px solid ${surface.rule}`,
    borderRadius: radius.lg,
    backgroundColor: surface.card,
    boxShadow: shadow.float,
  },

  ok: { color: accent.good, fontSize: 13, fontWeight: 500 },
  bad: { color: accent.danger, fontSize: 13, fontWeight: 500 },

  /** Secondary text: a line under a heading, a status, a short explanation */
  quiet: { fontSize: 13, color: ink.muted },
  /** The smallest text: a time, a count, a fine-print note */
  faint: { fontSize: 12, color: ink.faint },
  /** A short failure said in place, without the weight of `error` */
  dangerText: { fontSize: 13, color: accent.danger },
} satisfies Record<string, CSSProperties>;

export const palette = { ink, surface, accent, radius, font, display, mono, shadow, shapes: shapeColours };
