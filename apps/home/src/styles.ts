import type { CSSProperties } from 'react';
import { baseCss, hoverCss, hstack, palette, stack, styles as shared } from '@minca/app-shared/styles';

export { hstack, palette, stack };

const { ink, surface, accent, radius, display, mono, shadow } = palette;

/**
 * The sign-in element from `@minca/core` dressed as Minca: its
 * colours through the custom properties it reads, and the few shapes it
 * fixes itself, on the one scale: pill buttons and fields, options and boxes
 * at the row corner, a framed popover. Its sheet
 * is adopted after this one, so each rule starts at `html` to win.
 */
const authCss = `
    html minca-auth {
      --minca-ink: ${ink.strong};
      --minca-body: ${ink.body};
      --minca-muted: ${ink.muted};
      --minca-faint: ${ink.faint};
      --minca-surface: ${surface.card};
      --minca-sunken: ${surface.sunken};
      --minca-line: ${surface.line};
      --minca-line-strong: ${surface.lineStrong};
      --minca-accent: ${accent.base};
      --minca-accent-hover: ${accent.hover};
      --minca-on-accent: ${surface.card};
      --minca-danger: ${accent.danger};
      --minca-danger-soft: ${accent.dangerSoft};
      --minca-warn: ${accent.warn};
      --minca-good: ${accent.good};
      --minca-radius: ${radius.md}px;
      --minca-font: ${palette.font};
      --minca-mono: ${mono};
    }
    /* The page draws Minca's mark above the element, so its own goes. */
    html minca-auth .wa-wordmark { display: none; }
    html minca-auth .wa-card { max-width: none; }
    html minca-auth .wa-title { font-family: ${display}; font-weight: 700; font-size: 32px; line-height: 1.05; }
    html minca-auth .wa-button, html minca-auth .wa-secondary { border-radius: ${radius.pill}px; }
    html minca-auth .wa-secondary { border-color: ${surface.rule}; }
    /* A field for one line is a pill, as every control is; a checkbox is not a field. */
    html minca-auth input:not([type="checkbox"]):not([type="radio"]) { border-radius: ${radius.pill}px; padding: 0 16px; }
    html minca-auth .wa-option, html minca-auth .wa-error-box, html minca-auth .wa-code { border-radius: ${radius.md}px; }
    html minca-auth .wa-error-box { border: 1px solid ${accent.danger}; }
    html minca-auth .wa-option:not(:disabled):hover { border-color: ${surface.rule}; background: ${surface.card}; }
    html minca-auth input:focus { border-color: ${accent.base}; box-shadow: 0 0 0 3px ${accent.soft}; }
    html minca-auth input:focus-visible { outline: none; }
    html minca-auth :focus-visible { outline-color: ${accent.base}; }
    /* The account being signed in to is a card on the page: the rule, the surface corner. */
    html minca-auth .wa-account { border-color: ${surface.rule}; }
    html minca-auth .wa-account-open { border-radius: ${radius.lg}px; }
    html minca-auth .wa-account-row { border-radius: ${radius.pill}px; }
    html minca-auth .wa-popover { border-radius: ${radius.lg}px; border-color: ${surface.rule}; box-shadow: ${shadow.small}; }
`;

/**
 * The rules inline styles cannot carry.
 *
 * Called once at startup. Everything here is either a base reset or an
 * interactive state, apart from the space layout's one breakpoint, so the
 * inline styles stay the single place to look for how something is arranged.
 * Hover applies everywhere, before the base rules so that focus wins over it.
 */
export function injectBaseStyles(): void {
  if (globalThis.document.getElementById('minca-base-styles')) return;

  const style = globalThis.document.createElement('style');
  style.id = 'minca-base-styles';
  style.textContent = `
    ${hoverCss}
    ${baseCss}
    ${authCss}

    /* A choice that is ticked is drawn in navy, like a cell in a grid. */
    [data-choice]:has(input:checked) { border-color: ${surface.rule} !important; }

    @media (max-width: 520px) {
      [data-card] { padding: 28px 20px !important; }
    }

    /* The account page. A floating pill bar like the site's nav, the tabs as
       one segmented pill under it, and a column of content in the middle. */
    .home { min-height: 100vh; min-height: 100dvh; padding-bottom: 96px; }
    .home-nav {
      position: sticky; top: 0; z-index: 10;
      display: flex; flex-direction: column; align-items: center; gap: 12px;
      padding: 12px 16px 14px;
      background: linear-gradient(${surface.page} 78%, transparent);
    }
    .home-nav-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      width: 100%; max-width: 880px; height: 56px; padding: 0 8px 0 20px;
      border: 1px solid ${surface.rule}; border-radius: ${radius.pill}px; background: ${surface.page};
    }
    .home-brand { display: flex; align-items: center; gap: 10px; }
    .home-brand-label {
      padding-left: 10px; border-left: 1px solid ${surface.line};
      font-family: ${display}; font-size: 18px; font-weight: 700; letter-spacing: -0.04em; color: ${ink.muted};
    }
    .home-tabs {
      display: flex; gap: 2px; padding: 4px; max-width: 100%; overflow-x: auto; scrollbar-width: none;
      border: 1px solid ${surface.rule}; border-radius: ${radius.pill}px; background: ${surface.card};
    }
    .home-tabs::-webkit-scrollbar { display: none; }
    .home-tab {
      flex: none; height: 36px; padding: 0 18px; border: 0; border-radius: ${radius.pill}px;
      background: transparent; color: ${ink.muted}; font-size: 14px; font-weight: 500; white-space: nowrap;
    }
    .home-tab:hover { color: ${ink.strong}; }
    .home-tab[aria-selected="true"] { background: ${ink.strong}; color: ${surface.card}; }
    .home-main { max-width: 760px; margin: 0 auto; padding: 24px 16px 0; }
    .menu-item:not(:disabled):hover { background: ${surface.sunken} !important; }

    /* A tab's title, in the display face */
    .home-page-head { margin: 8px 0 24px; }
    .home-page-head h1 { font-size: 40px; line-height: 1.05; }
    .home-page-head p { margin-top: 8px; font-size: 16px; color: ${ink.muted}; }

    /* Colour tiles, as on the site: a shape colour mixed into the paper, its shape off the corner */
    .home-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .home-tile {
      position: relative; overflow: hidden; min-height: 240px;
      display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 28px;
      border: 1px solid ${surface.rule}; border-radius: ${radius.xl}px;
      background: color-mix(in srgb, var(--c) var(--minca-tint-tile), ${surface.page});
    }
    .home-tile[data-c="cobalt"] { --c: var(--minca-cobalt); }
    .home-tile[data-c="coral"] { --c: var(--minca-coral); }
    .home-tile[data-c="sage"] { --c: var(--minca-sage); }
    .home-tile[data-c="peach"] { --c: var(--minca-peach); }
    .home-tile[data-c="lilac"] { --c: var(--minca-lilac); }
    .home-tile > :not(.home-tile-art) { position: relative; z-index: 1; }
    .home-tile h2 { margin-top: 12px; font-size: 24px; letter-spacing: -0.04em; }
    .home-tile p { max-width: 230px; font-size: 15px; line-height: 1.45; color: ${ink.body}; }
    .home-tile button { margin-top: auto; }
    .home-tile-art {
      position: absolute; right: -44px; bottom: -44px; width: 170px; height: 170px;
      transition: transform .6s ease;
    }
    .home-tile:hover .home-tile-art { transform: rotate(20deg); }
    .home-chip {
      display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
      border: 1px solid ${surface.rule}; border-radius: ${radius.pill}px; background: ${surface.card};
      font-size: 12px; font-weight: 500; color: ${ink.strong};
    }
    .home-chip-warn { border-color: ${accent.warn}; background: ${accent.warnSoft}; color: ${accent.warn}; }

    @media (prefers-reduced-motion: reduce) { .home-tile-art { transition: none; } .home-tile:hover .home-tile-art { transform: none; } }
    @media (max-width: 640px) {
      .home-nav { padding: 8px 12px 12px; }
      .home-nav-bar { height: 52px; padding: 0 6px 0 16px; }
      .home-brand-label { display: none; }
      .home-tabs { align-self: stretch; }
      .home-tab { flex: 1; padding: 0 12px; }
      .home-page-head h1 { font-size: 32px; }
      .home-tiles { grid-template-columns: minmax(0, 1fr); }
      .home-tile { min-height: 0; padding: 24px; }
      .home-tile-art { width: 120px; height: 120px; right: -40px; bottom: -40px; }
      .home-tile p { max-width: 200px; }
    }
    @media (max-width: 420px) { .switcher-name { display: none; } }
  `;
  globalThis.document.head.appendChild(style);
}

/** The shared vocabulary, plus the home's own parts. The page it sits on is `.page`, from baseCss. */
export const styles = {
  ...shared,
  /** One part of the settings page: a tile on the paper */
  settingsSection: {
    ...shared.tile,
    padding: 20,
    marginBottom: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  /** A section's heading, in the display face */
  sectionHeading: {
    fontFamily: display,
    fontSize: 19,
    fontWeight: 700,
    letterSpacing: '-0.04em',
    lineHeight: 1.2,
    color: ink.strong,
  },
  /** What a section is for, under its heading */
  sectionText: { color: ink.muted, fontSize: 14, lineHeight: 1.5, marginTop: 4 },
  /** A line in a settings section: what it is on the left, what you can do about it on the right */
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    background: surface.sunken,
    borderRadius: radius.md,
    fontSize: 14,
  },
  /** An explanation on the consent page, set back from it: what something may do, or may not */
  note: {
    padding: '14px 16px',
    borderRadius: radius.md,
    backgroundColor: surface.sunken,
  },
  /** A line to tick, on the consent page */
  choice: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: `1px solid ${surface.line}`,
    borderRadius: radius.md,
    background: surface.card,
    fontSize: 14,
    color: ink.strong,
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
