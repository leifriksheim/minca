import type { CSSProperties } from 'react';
import { baseCss, hoverCss, palette, styles as shared } from '@minca/app-shared/styles';

export { palette };

const { ink, surface, accent, radius, display, mono, shadow } = palette;

/**
 * The sign-in element from `@minca/core` dressed as Minca: its
 * colours through the custom properties it reads, and the few shapes it
 * fixes itself (pill buttons, square options, a framed popover). Its sheet
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
      --minca-radius: ${radius.sm}px;
      --minca-font: ${palette.font};
      --minca-mono: ${mono};
    }
    /* The page draws Minca's mark above the element, so its own goes. */
    html minca-auth .wa-wordmark { display: none; }
    html minca-auth .wa-card { max-width: none; }
    html minca-auth .wa-title { font-family: ${display}; font-weight: 700; font-size: 32px; line-height: 1.05; }
    html minca-auth .wa-button, html minca-auth .wa-secondary { border-radius: ${radius.pill}px; }
    html minca-auth .wa-option, html minca-auth .wa-error-box, html minca-auth .wa-code { border-radius: 0; }
    html minca-auth .wa-error-box { border: 1px solid ${accent.danger}; }
    html minca-auth .wa-option:not(:disabled):hover { border-color: ${surface.rule}; box-shadow: ${shadow.small}; background: ${surface.card}; }
    html minca-auth input:focus { border-color: ${accent.base}; box-shadow: 0 0 0 3px ${accent.soft}; }
    html minca-auth input:focus-visible { outline: none; }
    html minca-auth :focus-visible { outline-color: ${accent.base}; }
    html minca-auth .wa-avatar { border-radius: 0; }
    html minca-auth .wa-popover { border-radius: 0; border-color: ${surface.rule}; box-shadow: ${shadow.small}; }
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
  `;
  globalThis.document.head.appendChild(style);
}

/** The shared vocabulary, plus the page the home's screens sit on. */
export const styles = {
  ...shared,
  container: {
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: '56px 20px 80px',
  },
  /** One part of the settings page: a square card on the paper */
  settingsSection: {
    border: `1px solid ${surface.line}`,
    borderRadius: radius.none,
    background: surface.card,
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
    letterSpacing: '-0.03em',
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
    borderRadius: radius.none,
    fontSize: 14,
  },
  /** A boxed explanation on the consent page: what something may do, or may not */
  note: {
    padding: '14px 16px',
    borderRadius: radius.none,
    border: `1px solid ${surface.line}`,
    backgroundColor: surface.sunken,
  },
  /** A line to tick, on the consent page */
  choice: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: `1px solid ${surface.line}`,
    borderRadius: radius.none,
    background: surface.card,
    fontSize: 14,
    color: ink.strong,
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;
