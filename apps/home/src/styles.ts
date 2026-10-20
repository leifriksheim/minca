import type { CSSProperties } from 'react';
import { baseCss, hoverCss, palette, styles as shared } from '@minca/app-shared/styles';

export { palette };

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
    html minca-auth .wa-avatar { border-radius: ${radius.sm}px; }
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

    /* The account page: a bar across the top, the tabs down the side and the
       tab beside them; on a narrow screen the tabs become a row of pills. */
    .home { min-height: 100vh; min-height: 100dvh; }
    .home-bar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 24px; background: ${surface.page}; border-bottom: 1px solid ${surface.line};
    }
    .home-bar-label { font-size: 15px; color: ${ink.muted}; }
    .home-layout {
      display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 40px;
      max-width: 1000px; margin: 0 auto; padding: 40px 24px 80px; align-items: start;
    }
    .home-tabs { position: sticky; top: 89px; display: flex; flex-direction: column; gap: 2px; }
    .home-tab {
      display: flex; align-items: center; height: 40px; padding: 0 16px;
      border: 1px solid transparent; border-radius: ${radius.pill}px; background: transparent;
      font-size: 14px; font-weight: 500; color: ${ink.body}; text-align: left; white-space: nowrap;
    }
    .home-tab:hover { background: ${surface.sunken}; }
    .home-tab[aria-selected="true"] { background: ${accent.soft}; color: ${accent.base}; }
    .menu-item:not(:disabled):hover { background: ${surface.sunken} !important; }
    /* Side by side where there is room; one per row on a phone. */
    .overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .overview > * { min-height: 200px; }
    @media (max-width: 760px) {
      .home-bar { padding: 10px 16px; }
      .home-bar-label { display: none; }
      .home-layout { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 16px 16px 64px; }
      .home-tabs { position: static; flex-direction: row; overflow-x: auto; scrollbar-width: none; margin: 0 -16px; padding: 0 16px; }
      .home-tab { border-color: ${surface.line}; }
      .home-tab[aria-selected="true"] { border-color: ${accent.base}; }
      .overview { grid-template-columns: minmax(0, 1fr); }
      .overview > * { min-height: 0; }
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
