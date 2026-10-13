import { baseCss, hoverCss, palette } from '@weave/app-shared/styles';
import { SHAPE_CYCLE, type ShapeColour } from '@weave/app-shared/tokens';
import { shapeFor, type ShapeKind } from '@weave/app-shared/shapes';

export { palette };

const { ink, surface, accent, radius, shadow, display } = palette;

/** The three answers, in the colours every bar and button uses */
export const tone = {
  for: accent.good,
  against: accent.danger,
  abstain: ink.faint,
  track: surface.line,
} as const;

/** The hue each shape colour is stored as, when a party picks one */
export const SHADE_HUES: Readonly<Record<ShapeColour, number>> = {
  cobalt: 230,
  coral: 10,
  peach: 38,
  sage: 150,
  lilac: 300,
  paper: 40,
  ink: 225,
};

/** The shape colour nearest a stored hue: records keep their hue, the screen draws it from the shapes' colours */
export function colourOf(hue: number): ShapeColour {
  const distance = (c: ShapeColour) => {
    const d = (((hue - SHADE_HUES[c]) % 360) + 360) % 360;
    return Math.min(d, 360 - d);
  };
  return SHAPE_CYCLE.reduce<ShapeColour>((best, c) => (distance(c) < distance(best) ? c : best), 'cobalt');
}

/** How a topic or a party is drawn: a shape picked by its name, in the colour nearest its hue */
export const markOf = (name: string, hue: number): { kind: ShapeKind; colour: ShapeColour } => ({
  kind: shapeFor(name).kind,
  colour: colourOf(hue),
});

/** The round shapes full enough to carry a letter in their middle */
const FULL: readonly ShapeKind[] = ['scallop', 'clover', 'squircle', 'burst', 'flower'];

/** A party's mark: like {@link markOf}, but always a shape its initial can sit on */
export const partyMarkOf = (name: string, hue: number): { kind: ShapeKind; colour: ShapeColour } => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return { kind: FULL[Math.abs(hash) % FULL.length] ?? 'scallop', colour: colourOf(hue) };
};

/** Text that sits on a shape: paper on the dark ones, navy on the light ones */
export const onShape = (colour: ShapeColour): string =>
  colour === 'peach' || colour === 'lilac' || colour === 'paper' ? ink.strong : surface.card;

/** Standalone, Liquid owns the page: Minca's base styles, then its own */
export function injectStandaloneStyles(): void {
  if (!globalThis.document.getElementById('liquid-base')) {
    const style = globalThis.document.createElement('style');
    style.id = 'liquid-base';
    style.textContent = `
      ${baseCss}
      @media (hover: hover) { ${hoverCss} }
      body { background: ${surface.page}; }
    `;
    globalThis.document.head.appendChild(style);
  }
  injectAppStyles();
}

/**
 * Liquid's own rules, all under `lq-`, for what inline styles cannot say:
 * hover, focus, motion and the phone layout. A host that mounts Liquid
 * already has Minca's base styles (`baseCss`), so this adds only these, and
 * touches nothing outside its own classes.
 */
export function injectAppStyles(): void {
  if (globalThis.document.getElementById('liquid-styles')) return;
  const style = globalThis.document.createElement('style');
  style.id = 'liquid-styles';
  style.textContent = `
    @media (hover: hover) {
      .lq-card[data-interactive]:hover { background: ${surface.sunken}; }
      .lq-card[data-interactive]:hover .shape { transform: rotate(18deg) scale(1.06); }
      .lq-btn:not([data-variant]):not(:disabled):hover { background: ${accent.hover}; border-color: ${accent.hover}; transform: translateY(-1px); }
      .lq-icon-btn:not(:disabled):hover { border-color: ${surface.rule}; color: ${ink.strong}; }
      .lq-upvote:not([aria-pressed="true"]):not(:disabled):hover { border-color: ${surface.rule}; color: ${ink.strong}; }
      .lq-vote:not([aria-pressed="true"]):not(:disabled):hover { background: ${surface.sunken}; }
      .lq-tab:not([aria-selected="true"]):hover { color: ${ink.strong}; }
      .lq-pick:hover { background: ${surface.sunken}; }
      .lq-chip[data-filter]:not([aria-pressed="true"]):hover { border-color: ${surface.rule}; color: ${ink.strong}; }
      .lq-link:hover { color: ${ink.strong}; text-decoration-color: ${ink.muted}; }
      .lq-tile-new:hover { color: ${ink.strong}; }
    }

    .lq-tabbar { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid ${surface.line}; margin-bottom: 24px; }

    .lq-shell { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
    /* Paper, not frosted glass: nothing blurs */
    .lq-header {
      position: sticky; top: 0; z-index: 20;
      background: ${surface.page};
      border-bottom: 1px solid ${surface.line};
    }
    .lq-header-inner { max-width: 820px; margin: 0 auto; padding: 0 24px; }
    .lq-bar { display: flex; align-items: center; gap: 12px; height: 60px; }
    .lq-main { width: 100%; max-width: 820px; margin: 0 auto; padding: 28px 24px 96px; flex: 1; }

    /* Titles in the display face, wherever Liquid is mounted */
    .lq-display { font-family: ${display}; font-weight: 700; letter-spacing: -0.04em; color: ${ink.strong}; }

    .lq-tabs { display: flex; gap: 22px; margin-bottom: -1px; }
    .lq-tab {
      position: relative; display: inline-flex; align-items: center; gap: 6px;
      height: 42px; padding: 0; border: none; background: none;
      font-size: 14px; font-weight: 500; color: ${ink.muted}; white-space: nowrap;
      border-bottom: 2px solid transparent;
    }
    .lq-tab[aria-selected="true"] { color: ${ink.strong}; border-bottom-color: ${ink.strong}; }
    .lq-tab-count {
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: ${radius.pill}px;
      display: inline-flex; align-items: center; justify-content: center;
      background: ${surface.sunken}; border: 1px solid ${surface.line};
      font-size: 11px; font-weight: 600; color: ${ink.muted}; font-variant-numeric: tabular-nums;
    }

    /* Controls are pills: cobalt for the thing to do, navy under the pointer */
    .lq-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 36px; padding: 0 16px; border-radius: ${radius.pill}px; border: 1px solid ${accent.base};
      font-size: 14px; font-weight: 500; white-space: nowrap;
      background: ${accent.base}; color: ${surface.card};
      transition: background-color .15s ease, border-color .15s ease, color .15s ease, transform .15s cubic-bezier(.3, 1.6, .5, 1);
    }
    .lq-btn:active:not(:disabled) { transform: scale(.98); }
    .lq-btn[data-variant="quiet"] { background: ${surface.card}; color: ${ink.body}; }
    .lq-btn[data-variant="ghost"] { background: none; border-color: transparent; color: ${ink.muted}; padding: 0 10px; }
    .lq-btn[data-variant="danger"] { background: ${surface.card}; color: ${accent.danger}; border-color: ${surface.line}; }
    .lq-btn[data-size="sm"] { height: 30px; padding: 0 12px; font-size: 13px; }
    .lq-btn[data-size="lg"] { height: 46px; padding: 0 24px; font-size: 15px; }
    .lq-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: ${radius.pill}px; border: 1px solid ${surface.lineStrong};
      background: ${surface.card}; color: ${ink.muted}; font-size: 15px; font-weight: 600;
    }

    .lq-input, .lq-textarea {
      width: 100%; padding: 0 12px; border-radius: ${radius.md}px; border: 1px solid ${surface.lineStrong};
      background: ${surface.card}; color: ${ink.strong}; font-size: 14px; outline: none;
    }
    .lq-input { height: 40px; }
    .lq-textarea { padding: 10px 12px; min-height: 120px; resize: vertical; line-height: 1.55; }
    .lq-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: ${ink.muted}; }

    /* Surfaces are square, with hairlines */
    .lq-card {
      border: 1px solid ${surface.line}; border-radius: ${radius.lg}px; background: ${surface.card};
      transition: border-color .15s ease, background-color .15s ease;
    }
    .lq-card[data-interactive] { cursor: pointer; }
    .lq-card .shape { transition: transform .5s cubic-bezier(.3, 1.6, .5, 1); }
    /* What floats over the page: a navy frame and a flat shadow */
    .lq-float { border: 1px solid ${surface.rule}; border-radius: ${radius.lg}px; background: ${surface.card}; box-shadow: ${shadow.float}; }

    .lq-proposal { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 14px; padding: 16px 18px 16px 14px; }
    .lq-upvote {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      width: 48px; height: 56px; border-radius: ${radius.pill}px; border: 1px solid ${surface.lineStrong};
      background: ${surface.card}; color: ${ink.muted}; font-size: 13px; font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .lq-upvote svg { transition: transform .15s ease; }
    .lq-upvote[aria-pressed="true"] { background: ${accent.base}; border-color: ${accent.base}; color: ${surface.card}; }
    .lq-upvote[aria-pressed="true"] svg { transform: translateY(-1px); }

    .lq-chip {
      display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px;
      border-radius: ${radius.pill}px; border: 1px solid ${surface.line}; background: ${surface.card};
      font-size: 12px; font-weight: 500; color: ${ink.body}; white-space: nowrap;
    }
    .lq-chip[data-filter] { height: 30px; padding: 0 12px; font-size: 13px; color: ${ink.muted}; }
    .lq-chip[data-filter][aria-pressed="true"] { background: ${ink.strong}; border-color: ${ink.strong}; color: ${surface.card}; }
    .lq-chip[data-filter][data-outline][aria-pressed="true"] { background: ${surface.card}; color: ${ink.strong}; }
    .lq-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

    .lq-meter { display: flex; height: 6px; border-radius: ${radius.sm}px; overflow: hidden; background: ${tone.track}; }
    .lq-meter > span { height: 100%; transition: width .4s cubic-bezier(.2, .8, .2, 1); }
    .lq-meter[data-size="lg"] { height: 10px; }

    /* The three answers side by side, sharing navy rules */
    .lq-votes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid ${surface.rule}; }
    .lq-vote {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
      height: 76px; border: none; border-radius: 0; background: ${surface.card};
      font-size: 14px; font-weight: 600; color: ${ink.body};
      transition: background-color .15s ease, color .15s ease;
    }
    .lq-vote + .lq-vote { border-left: 1px solid ${surface.rule}; }
    .lq-vote:active:not(:disabled) { background: ${surface.sunken}; }
    .lq-vote[aria-pressed="true"] { color: ${surface.card}; }
    .lq-vote[data-choice="for"][aria-pressed="true"] { background: ${tone.for}; }
    .lq-vote[data-choice="against"][aria-pressed="true"] { background: ${tone.against}; }
    .lq-vote[data-choice="abstain"][aria-pressed="true"] { background: ${ink.body}; }
    .lq-vote small { font-size: 11px; font-weight: 500; opacity: .75; }

    .lq-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
    .lq-row + .lq-row { border-top: 1px solid ${surface.line}; }
    .lq-pick {
      display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 10px;
      border: none; border-radius: 0; background: none; text-align: left; font-size: 14px; color: ${ink.body};
    }
    .lq-pick[aria-pressed="true"] { background: ${surface.sunken}; box-shadow: inset 0 0 0 1px ${surface.rule}; }

    .lq-stack { display: flex; }
    .lq-stack > * { box-shadow: 0 0 0 2px ${surface.card}; border-radius: 6px; }
    .lq-stack > * + * { margin-left: -6px; }

    .lq-section-title { font-size: 13px; font-weight: 600; color: ${ink.strong}; letter-spacing: -0.01em; }
    .lq-muted { color: ${ink.muted}; }
    .lq-faint { color: ${ink.faint}; }
    .lq-num { font-variant-numeric: tabular-nums; }
    .lq-link { background: none; border: none; padding: 0; font: inherit; color: ${ink.body}; text-decoration: underline; text-decoration-color: ${surface.lineStrong}; text-underline-offset: 3px; }

    .lq-empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
      padding: 48px 24px; border: 1px dashed ${surface.lineStrong}; border-radius: ${radius.lg}px; color: ${ink.muted};
    }
    .lq-note {
      display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: ${radius.lg}px;
      background: ${surface.sunken}; border: 1px solid ${surface.line}; font-size: 13px; line-height: 1.55; color: ${ink.body};
    }
    .lq-note[data-tone="warn"] { border-color: ${accent.warn}; }
    .lq-note[data-tone="bad"] { background: ${accent.dangerSoft}; border-color: ${accent.danger}; }
    .lq-note[data-tone="good"] { background: ${accent.goodSoft}; border-color: ${accent.good}; }

    /* Cells set side by side share navy rules, with no gaps, however many fit in a row */
    .lq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); padding: 1px 0 0 1px; }
    .lq-grid > * { margin: -1px 0 0 -1px; border: 1px solid ${surface.rule}; }
    .lq-tile { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 18px; min-height: 160px; text-align: left; font: inherit; color: inherit; }
    .lq-tile-new { align-items: center; justify-content: center; gap: 8px; color: ${ink.muted}; background: none; }
    .lq-cell-num { font-size: 13px; font-style: italic; color: ${ink.strong}; }

    .lq-path { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; }
    .lq-path-arrow { color: ${ink.faint}; }

    .lq-rise { animation: weave-rise .22s cubic-bezier(.2, .8, .2, 1) both; }
    .lq-fade { animation: weave-fade .2s ease both; }

    .lq-hero-art { width: 100%; max-width: 440px; height: auto; }
    /* How far below the top a column sticks: under the standalone header, or at the top of a host's frame */
    .lq-aside { position: sticky; top: var(--lq-sticky-top, 16px); }
    .lq-shell { --lq-sticky-top: 84px; }
    .lq-two { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
    .lq-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .lq-scroll-x { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .lq-scroll-x::-webkit-scrollbar { display: none; }
    .lq-scroll-x > * { flex-shrink: 0; }

    @media (prefers-reduced-motion: reduce) {
      .lq-rise, .lq-fade { animation: none; }
      .lq-card .shape, .lq-btn, .lq-meter > span { transition: none; }
    }
    @media (max-width: 760px) {
      .lq-two { grid-template-columns: minmax(0, 1fr); }
      .lq-aside { position: static; }
    }
    @media (max-width: 640px) {
      .lq-header-inner { padding: 0 16px; }
      .lq-main { padding: 20px 16px 88px; }
      .lq-proposal { grid-template-columns: 42px minmax(0, 1fr); gap: 12px; padding: 14px 14px 14px 12px; }
      .lq-upvote { width: 42px; height: 50px; }
      .lq-tabs { gap: 18px; }
      .lq-hide-phone { display: none !important; }
      .lq-vote { height: 64px; }
    }
  `;
  globalThis.document.head.appendChild(style);
}
