import type { CSSProperties } from 'react';
import { baseCss, hoverCss, hstack, palette, stack, styles } from '@minca/app-shared/styles';

export { hstack, palette, stack, styles };

const { ink, surface, accent, radius, shadow } = palette;

/** A navy wash over what is behind it, for overlays and labels on video */
const navyWash = (percent: number) => `color-mix(in srgb, ${ink.strong} ${percent}%, transparent)`;

/** How tall the bar along a phone's bottom edge is, with room under it */
/** A phone's tab bar, floating over the foot of the page: its height, and the gap under it */
const TABBAR_HEIGHT = 64;
const TABBAR_GAP = 10;
/** How wide a space's rail of apps is */
const RAIL_WIDTH = 232;

/**
 * The rules inline styles cannot carry.
 *
 * Called once at startup. Everything here is a base reset, an interactive
 * state, or layout that changes with the screen: inline styles cannot hold a
 * media query, so anything arranged differently on a phone takes a class here
 * instead of an inline style. The rest of the layout stays inline.
 */
export function injectBaseStyles(): void {
  if (globalThis.document.getElementById('minca-base-styles')) return;

  const style = globalThis.document.createElement('style');
  style.id = 'minca-base-styles';
  style.textContent = `
    ${baseCss}

    /* Hover only where there is a pointer that hovers. On a touchscreen a
       tap would otherwise leave the hover look stuck on whatever was tapped. */
    @media (hover: hover) {
      ${hoverCss}
      .rail-item:not([aria-current]):hover .rail-icon { background: ${surface.line}; }
      .app-rail .rail-item:not([aria-current]):hover { background: ${surface.line}; }
      .you-button:hover, .you-button[aria-expanded="true"],
      .group-button:hover, .group-button[aria-expanded="true"] { background: ${surface.line} !important; }
      .quick-action:not(:disabled):hover { background: ${surface.sunken}; }
    }

    /* ── Layout that follows the screen ──────────────────────────────────
       One breakpoint for "phone" (640px) and one for "too narrow for a side
       column" (760px). Touch is asked about separately, with pointer: coarse,
       since a small laptop window is not a phone and a tablet is not a mouse. */

    /* .page and .space-layout come from baseCss: the home's screens sit on the same page. */

    /* In a space: its apps down a rail, and whatever is open beside it, each
       the height of the window and scrolling on its own, the way chat apps are. */

    .space-shell { display: grid; grid-template-columns: ${RAIL_WIDTH}px minmax(0, 1fr); height: 100vh; height: 100dvh; }
    .app-rail {
      position: relative; z-index: 15; display: flex; flex-direction: column; min-height: 0; padding: 10px 8px;
      background: ${surface.sunken}; border-right: 1px solid ${surface.rule};
    }
    /* Only the apps scroll, so the menus at the foot can open out past the rail's edge. */
    .rail-apps {
      flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px;
      overflow-y: auto; scrollbar-width: none; margin: -4px -6px 0; padding: 4px 6px 0;
    }
    /* In the desktop app's window (apps/desktop), which has no title bar: room for its buttons. */
    :root[data-desktop] .app-rail { padding-top: 44px; }
    /* An app on the rail: its shape, its name under it, and a tile of its own while it is open. */
    .rail-item {
      position: relative; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 7px 2px 6px; border: none; border-radius: ${radius.md}px; background: none;
      color: ${ink.muted}; font-size: 11.5px; font-weight: 500;
    }
    .rail-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* On the rail an app is one row, its shape beside its name, and the open one's row a tile of its own. */
    .app-rail .rail-item { flex-direction: row; gap: 10px; padding: 4px 8px 4px 4px; font-size: 14px; text-align: left; }
    .app-rail .rail-icon { width: 32px; height: 32px; flex-shrink: 0; }
    .app-rail .rail-item[aria-current], .app-rail .rail-item[aria-current] .rail-icon { background: ${surface.line}; }
    /* The open app: a soft square behind its shape alone, a shade darker than what it sits on, and its name in bold. */
    .rail-icon {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: ${radius.md}px; transition: background-color .15s ease;
    }
    .rail-item[aria-current] { color: ${ink.strong}; font-weight: 600; }
    .rail-item[aria-current] .rail-icon { background: ${surface.line}; }
    .app-switch .rail-icon { width: 54px; height: 54px; }
    .app-switch .rail-item[aria-current] .rail-icon { background: ${surface.sunken}; }
    .rail-count { position: absolute; top: -2px; right: -4px; pointer-events: none; }
    .rail-count .count { box-shadow: 0 0 0 2px ${surface.sunken}; }
    /* The space itself, first: its face opens its menu. */
    .rail-top { flex-shrink: 0; display: flex; padding-bottom: 8px; margin-bottom: 6px; border-bottom: 1px solid ${surface.line}; }
    .rail-top > div { flex: 1; min-width: 0; }
    /* Every app, from a phone's bar: their shapes in a grid of three, as the rail has them. */
    .app-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
    .app-switch > .rail-item { padding: 12px 4px 10px; font-size: 12.5px; gap: 6px; }
    /* Where the next app goes: an empty tile, dashed. */
    .rail-slot {
      display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
      border: 1.5px dashed ${surface.lineStrong}; border-radius: ${radius.sm}px; color: ${ink.muted};
    }
    /* What isn't an app has a glyph on the same tile an app's shape takes. */
    .rail-glyph { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; color: ${ink.body}; }
    /* You and what's new for you, at the foot; their menus open beside them. */
    .rail-foot {
      position: relative; flex-shrink: 0; padding-top: 8px; display: flex; align-items: center; gap: 4px;
      border-top: 1px solid ${surface.line};
    }
    /* You, as a row: your picture and your name, what's new for you beside it, as Discord has it. */
    .rail-foot > :first-child { flex: 1; min-width: 0; }
    .you-button {
      display: flex; align-items: center; gap: 10px; width: 100%; height: 44px; padding: 0 8px 0 4px;
      border: none; border-radius: ${radius.md}px; background: none; font-size: 14px; font-weight: 600;
      color: ${ink.strong}; text-align: left;
    }
    .side-item {
      display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px;
      border: none; border-radius: ${radius.pill}px; background: none; font-size: 14px; text-align: left;
    }
    .side-item[aria-current] { background: ${surface.card}; box-shadow: 0 0 0 1px ${surface.rule}; }
    .space-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    /* A phone's bar along the foot of a space (below); a wide screen has the rail. */
    .space-bar {
      flex-shrink: 0; display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 24px;
      border-bottom: 1px solid ${surface.rule}; background: ${surface.page};
    }
    .space-content { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 32px 64px; }
    /* Moving between pages (transitions.ts): short and soft. Forward, the new page comes in from a
       little to the right as the old one leaves a little to the left; back, the other way; a cross-fade
       between tabs or apps. The bars and the rail stay where they are while the page moves. */
    ::view-transition-old(root), ::view-transition-new(root) { animation-duration: .18s; animation-timing-function: cubic-bezier(.2, .8, .2, 1); }
    html:active-view-transition-type(forward)::view-transition-old(root) { animation: vt-out-left .22s cubic-bezier(.2, .8, .2, 1) both; }
    html:active-view-transition-type(forward)::view-transition-new(root) { animation: vt-in-right .22s cubic-bezier(.2, .8, .2, 1) both; }
    html:active-view-transition-type(back)::view-transition-old(root) { animation: vt-out-right .22s cubic-bezier(.2, .8, .2, 1) both; }
    html:active-view-transition-type(back)::view-transition-new(root) { animation: vt-in-left .22s cubic-bezier(.2, .8, .2, 1) both; }
    html:active-view-transition-type(fade)::view-transition-old(root) { animation: vt-fade-out .14s ease both; }
    html:active-view-transition-type(fade)::view-transition-new(root) { animation: vt-fade-in .2s cubic-bezier(.2, .8, .2, 1) both; }
    @keyframes vt-out-left { to { opacity: 0; transform: translateX(-16px); } }
    @keyframes vt-in-right { from { opacity: 0; transform: translateX(16px); } }
    @keyframes vt-out-right { to { opacity: 0; transform: translateX(16px); } }
    @keyframes vt-in-left { from { opacity: 0; transform: translateX(-16px); } }
    @keyframes vt-fade-out { to { opacity: 0; } }
    @keyframes vt-fade-in { from { opacity: 0; transform: translateY(4px); } }
    .tabbar { view-transition-name: tabbar; }
    .space-bar { view-transition-name: space-bar; }
    .app-rail { view-transition-name: app-rail; }
    @media (prefers-reduced-motion: reduce) {
      ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
    }

    /* Data arriving: a hairline along the top of the screen, a light running across it, there only while
       records come in and fading as they stop (SyncLine). */
    .sync-line {
      position: fixed; z-index: 30; top: env(safe-area-inset-top); left: 0; right: 0; height: 2px; overflow: hidden;
      pointer-events: none; opacity: 0; transition: opacity .4s ease;
    }
    .sync-line[data-on] { opacity: 1; transition-duration: .15s; }
    .sync-line::after {
      content: ''; position: absolute; top: 0; bottom: 0; width: 40%;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, ${accent.base} 55%, transparent), transparent);
      animation: sync-run 1.1s ease-in-out infinite;
    }
    @keyframes sync-run { from { left: -40%; } to { left: 100%; } }
    @media (prefers-reduced-motion: reduce) {
      .sync-line::after { animation: none; left: 0; width: 100%; background: color-mix(in srgb, ${accent.base} 35%, transparent); }
    }
    .space-inner { max-width: 1040px; margin: 0 auto; }
    .space-inner[data-wide] { max-width: none; }
    /* An app that is a conversation, or a screen of its own, gets every pixel, edge to edge. */
    .space-content[data-fill] { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
    .space-content[data-fill] > .space-inner { flex: 1; min-height: 0; width: 100%; max-width: none; display: flex; flex-direction: column; }
    .phone-only { display: none !important; }

    /* Designing a collection: the form, and beside it a preview of what filling one in looks like. */
    .designer { grid-template-columns: minmax(0, 1fr); }
    .designer-preview { position: static !important; }
    @media (min-width: 1500px) {
      .designer { grid-template-columns: minmax(0, 1fr) 300px; }
      .designer-preview { position: sticky !important; }
    }

    /* How many new things there are: on an icon's corner, or at the end of a row. */
    .count {
      display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: ${radius.pill}px;
      background: ${accent.danger}; color: ${surface.card}; font-size: 11px; font-weight: 600; line-height: 1;
    }
    /* Only new, nothing for you: there, but not calling. */
    .count[data-quiet] { background: ${ink.muted}; }
    /* Nested data in a record: a caret that turns when it opens */
    .value-fold > summary::-webkit-details-marker { display: none; }
    .value-fold > summary::before { content: '▸'; display: inline-block; width: 12px; color: ${ink.faint}; transition: transform .1s ease; }
    .value-fold[open] > summary::before { transform: rotate(90deg); }
    /* An account on several devices: a caret at the row's end that turns when it opens */
    .peer-fold > summary { list-style: none; }
    .peer-fold > summary::-webkit-details-marker { display: none; }
    .peer-fold > summary::after { content: '▸'; color: ${ink.faint}; transition: transform .1s ease; }
    .peer-fold[open] > summary::after { transform: rotate(90deg); }


    /* A row that scrolls sideways instead of wrapping, with no scrollbar in the way. */
    .scroll-x { overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .scroll-x::-webkit-scrollbar { display: none; }
    .scroll-x > * { flex-shrink: 0; white-space: nowrap; }

    /* The row of a space's own pages atop its Overview: an icon over its name, each an equal share. */
    .quick-row { display: flex; align-items: center; gap: 4px; }
    .quick-row > .quick-action { flex: 1 0 64px; max-width: 112px; }
    /* Centred, yet scrolled from its start when it overflows (justify-content: center would cut it off). */
    .quick-row > :first-child { margin-left: auto; }
    .quick-row > :last-child { margin-right: auto; }
    .quick-action {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      padding: 10px 6px; border: none; border-radius: ${radius.md}px; background: none;
      font: inherit; font-size: 12px; font-weight: 500; color: ${ink.body}; cursor: pointer;
    }


    /* A space: its collections down the side, the chosen one beside them. */
    .space-side { display: flex; flex-direction: column; gap: 28px; }
    .collection-nav { display: flex; flex-direction: column; gap: 2px; }

    /* Ready-made apps to add, one under the other. */
    .app-list { display: flex; flex-direction: column; gap: 8px; }

    /* Views that sit side by side under one heading, like Under the hood's. */
    .segmented { display: flex; gap: 2px; align-self: flex-start; max-width: 100%; padding: 4px; border-radius: ${radius.pill}px; background: ${surface.sunken}; }
    .segmented > button {
      display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px;
      border: 1px solid transparent; border-radius: ${radius.pill}px; background: none; color: ${ink.muted}; font-size: 13px; font-weight: 500;
    }
    .segmented > button:hover { color: ${ink.strong}; }
    .segmented > button[aria-selected="true"] { background: ${surface.card}; border-color: ${surface.rule}; color: ${ink.strong}; }

    /* Home, Activity and You: a pill along the top of a wide screen, the
       bottom edge of a phone's (below). */
    .tabbar {
      display: flex; gap: 2px; align-self: center; width: fit-content; margin: 0 auto 28px; padding: 4px;
      border: 1px solid ${surface.rule}; border-radius: ${radius.pill}px; background: ${surface.card};
    }
    .tabbar > a {
      position: relative; display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px 0 12px;
      border-radius: ${radius.pill}px; color: ${ink.muted}; font-size: 14px; font-weight: 500; text-decoration: none;
    }
    .tabbar > a:hover { color: ${ink.strong}; }
    .tabbar > a[aria-current="page"] { background: ${surface.sunken}; color: ${ink.strong}; }
    .tab-dot {
      position: absolute; top: 6px; left: 24px; width: 8px; height: 8px;
      border-radius: ${radius.pill}px; background: ${accent.danger}; box-shadow: 0 0 0 2px ${surface.card};
    }

    /* A search box looks like any field; the people search draws its own clear button. */
    input[type="search"] { -webkit-appearance: none; appearance: none; }
    input[type="search"]::-webkit-search-cancel-button { display: none; }

    /* A small change offered inside a sentence: its words, underlined once pointed at. */
    .quiet-link { padding: 0; border: none; background: none; font: inherit; color: ${ink.body}; text-decoration: none; text-underline-offset: 3px; }
    .quiet-link:hover, .quiet-link[aria-expanded="true"] { text-decoration: underline; color: ${ink.strong}; }
    /* A name edited where it is shown (ProfilePage.tsx): a heading until it is pointed at. */
    .name-input:hover { border-color: ${surface.line} !important; }
    .name-input:focus { border-color: ${surface.rule} !important; background: ${surface.page} !important; outline: none; }

    .graph-canvas { height: 600px; }
    .collection-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .collection-search { width: 180px; }

    /* Calls: over every page, never part of one (components/calls). */
    .call-panel {
      position: fixed; z-index: 30; right: 20px; bottom: 20px; width: 340px;
      display: flex; flex-direction: column; gap: 12px; padding: 14px;
      background: ${surface.card}; border: 1px solid ${surface.rule}; border-radius: ${radius.lg}px;
      box-shadow: ${shadow.float};
    }
    /* The stage is dark so faces stand out: the navy ink, not black. */
    .call-stage {
      top: 20px; left: 20px; width: auto;
      background: ${ink.strong}; border-color: ${ink.strong}; color: ${surface.page};
    }
    .call-stage .call-tiles { flex: 1; }
    .call-tiles { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 0; }
    .call-tiles[data-count="1"] { grid-template-columns: minmax(0, 1fr); }
    .call-tiles[data-large][data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .call-tiles[data-large]:is([data-count="3"], [data-count="4"]) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .call-tiles[data-large]:is([data-count="5"], [data-count="6"]) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .call-tile {
      position: relative; margin: 0; aspect-ratio: 4 / 3; overflow: hidden; border-radius: ${radius.md}px;
      display: flex; align-items: center; justify-content: center; background: ${ink.body};
    }
    .call-stage .call-tile { aspect-ratio: auto; min-height: 120px; }
    .call-name {
      position: absolute; left: 6px; bottom: 6px; display: inline-flex; align-items: center; gap: 4px;
      max-width: calc(100% - 12px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 8px; border-radius: ${radius.pill}px; font-size: 12px; color: ${surface.card}; background: ${navyWash(60)};
    }
    .call-pip { display: flex; height: 100vh; padding: 6px; box-sizing: border-box; }
    .call-pip .call-tiles { flex: 1; }
    .call-pip .call-tile { aspect-ratio: auto; }
    .call-stack {
      position: fixed; z-index: 31; top: 16px; right: 20px; width: 320px;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .call-card {
      pointer-events: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px;
      background: ${surface.card}; border: 1px solid ${surface.rule}; border-radius: ${radius.lg}px;
      box-shadow: ${shadow.float}; font-size: 14px;
    }
    .call-overlay {
      position: fixed; z-index: 40; inset: 0; padding: 16px;
      display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center;
      /* An image, not a colour, so Safari on iOS doesn't tint its status bar with it (scrim, in @minca/app-shared/styles). */
      background-image: linear-gradient(${surface.scrim}, ${surface.scrim});
    }
    .call-incoming { width: min(340px, 100%); align-items: center; text-align: center; gap: 16px; padding: 24px; }
    .call-ringing { display: inline-flex; border-radius: 50%; animation: call-ring 1.2s ease-out infinite; }
    @keyframes call-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, ${accent.good} 45%, transparent); } 100% { box-shadow: 0 0 0 12px transparent; } }
    @media (prefers-reduced-motion: reduce) { .call-ringing { animation: none; } }

    /* Events: covers in a grid, the next one large, a month to look across (components/apps/Events.tsx). */
    .ev-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
    .ev-hero { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); overflow: hidden; border-radius: ${radius.lg}px !important; }
    .ev-hero > button { display: block; width: 100%; }
    .ev-hero-cover { height: 100%; min-height: 260px; }
    .ev-banner { height: 240px; }
    .ev-detail { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 36px; align-items: start; }
    .ev-form-row { display: flex; gap: 10px; }
    .ev-month {
      display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
      border: 1px solid ${surface.rule}; border-radius: ${radius.lg}px; overflow: hidden; background: ${surface.rule}; gap: 1px;
    }
    .ev-weekday { padding: 8px 10px; background: ${surface.sunken}; color: ${ink.muted}; font-size: 12px; font-weight: 500; }
    .ev-day { min-height: 108px; padding: 6px; display: flex; flex-direction: column; gap: 3px; background: ${surface.card}; cursor: pointer; min-width: 0; }
    .ev-day[data-other] { background: ${surface.sunken}; }
    .ev-day[data-other] .ev-day-number { color: ${ink.faint}; }
    .ev-day[data-picked] { box-shadow: inset 0 0 0 2px ${accent.base}; }
    .ev-day-number {
      align-self: flex-start; display: inline-flex; align-items: center; justify-content: center;
      min-width: 24px; height: 24px; padding: 0 4px; border-radius: ${radius.pill}px; font-size: 12px; font-weight: 500; color: ${ink.body};
    }
    .ev-day-number[data-today] { background: ${accent.base}; color: ${surface.card}; font-weight: 600; }
    .ev-chip {
      display: block; width: 100%; border: none; border-radius: ${radius.sm}px; padding: 2px 6px; text-align: left;
      font-size: 11.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ev-more { font-size: 11px; color: ${ink.faint}; padding-left: 6px; }
    .ev-dots { display: none; gap: 3px; justify-content: center; }
    .ev-dots > i { width: 6px; height: 6px; border-radius: ${radius.pill}px; }

    /* Marketplace: square pictures in a grid, prices first (components/apps/Marketplace.tsx). */
    .mk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 24px 16px; }
    .mk-tools { display: flex; gap: 8px; }
    .mk-photo { transition: filter .2s ease; }
    .mk-detail { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 32px; align-items: start; }
    @media (hover: hover) {
      /* Nothing moves: the picture only darkens a little. */
      .mk-card:hover .mk-photo { filter: brightness(.96); }
      .ev-chip:hover { filter: brightness(.96); }
      .ev-day:not([data-picked]):hover { background: ${surface.sunken}; }
    }

    @media (max-width: 760px) {
      .ev-hero, .ev-detail, .mk-detail { grid-template-columns: minmax(0, 1fr); }
      .ev-hero-cover { min-height: 180px; }
      .ev-banner { height: 170px; }
    }
    @media (max-width: 640px) {
      .ev-grid { grid-template-columns: minmax(0, 1fr); }
      .ev-form-row { flex-direction: column; }
      .ev-day { min-height: 54px; align-items: center; padding: 4px 2px; }
      .ev-day-number { align-self: center; }
      .ev-chip, .ev-more { display: none; }
      .ev-dots { display: flex; }
      .ev-weekday { padding: 6px 2px; text-align: center; font-size: 11px; }
      .mk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 10px; }
    }

    @media (max-width: 900px) {
      .space-shell { grid-template-columns: 200px minmax(0, 1fr); }
      .space-content { padding: 20px 20px 48px; }
      .space-bar { padding: 0 20px; }
    }

    @media (max-width: 760px) {
      /* The side column comes apart: its collections become a row of
         tabs above the list, and who is here and the invite go below it,
         so the thing you opened the space for is on the first screen. */
      .space-side { display: contents; }
      .space-side > section { order: 1; }
      .collection-nav { flex-direction: row; gap: 6px; margin: 0 -16px; padding: 0 16px; overflow-x: auto; scrollbar-width: none; }
      .collection-nav::-webkit-scrollbar { display: none; }
      .collection-nav > * { flex-shrink: 0; white-space: nowrap; }
      .collection-nav [data-nav] { border: 1px solid ${surface.line} !important; border-radius: ${radius.pill}px !important; padding: 0 12px !important; }
      .collection-nav [data-nav][aria-current] { border-color: ${ink.strong} !important; }
      .collection-nav-heading { display: none; }
    }

    @media (max-width: 640px) {
      .page {
        padding: 12px max(16px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      /* Room under the last row for the bar along the bottom. */
      .page:has(> * > .tabbar) { padding-bottom: calc(${TABBAR_HEIGHT + TABBAR_GAP + 40}px + env(safe-area-inset-bottom)); }

      /* In a space a phone has no tab bar: the way back is at the left of
         the space's bar, and its apps open from the right of it rather than
         a sidebar. */
      .app-rail, .hide-on-phone, .bar-label { display: none !important; }
      .phone-only { display: revert !important; }
      .segmented.phone-only { display: flex !important; }
      .space-shell { display: block; height: auto; min-height: 100dvh; }
      /* At least the screen's height, the content taking what is spare, clear of the rounded foot of the screen. */
      .space-main { min-height: 100dvh; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom); }
      .space-content { flex: 1 0 auto; }
      /* Back, where you are, the apps: the middle stays in the middle whatever is at either end. */
      .space-bar {
        /* No rule under it: on a phone the bar and the page are one. */
        border-bottom: none;
        display: grid; grid-template-columns: minmax(40px, 1fr) minmax(0, auto) minmax(40px, 1fr);
        position: sticky; top: 0; z-index: 8; height: auto; min-height: 56px; gap: 8px;
        padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
        background: ${surface.page};
      }
      .space-content {
        overflow: visible;
        padding: 16px max(16px, env(safe-area-inset-right)) 24px max(16px, env(safe-area-inset-left));
      }
      /* An open app is the whole screen, with the way back at its top, as a conversation is on a phone.
         It is pinned to the page rather than 100dvh tall, which ignores the keyboard: a browser that
         shrinks the page for the keyboard shrinks the app with it, so its field stays above the keyboard. */
      .space-shell[data-app-open] { position: fixed; inset: 0; min-height: 0; }
      .space-shell[data-app-open] .space-content { overflow-y: auto; padding-bottom: 24px; }
      .space-shell[data-app-open] .space-main { display: flex; height: 100%; min-height: 0; }
      .space-shell[data-app-open] .space-bar { position: static; }
      .bar-end { display: flex !important; min-width: 0; }
      .bar-middle { display: flex !important; justify-content: center; min-width: 0; }
      /* What fills the space runs right down to the foot of the screen. */
      .space-content[data-fill], .space-shell[data-app-open] .space-content[data-fill] { padding: 0; }


      /* A pill floating over the foot of the page, the page showing through it, blurred; the tab you are
         on a softer pill inside it, as chat apps have it now. */
      .tabbar {
        /* Under the page's bars (z-index 8): as a flex item it is a layer of its own even when static,
           so a dialog opened from it can rise no higher than 8. */
        position: fixed; z-index: 7; width: auto; margin: 0; gap: 2px; height: ${TABBAR_HEIGHT}px; padding: 5px;
        left: max(16px, env(safe-area-inset-left)); right: max(16px, env(safe-area-inset-right));
        bottom: calc(${TABBAR_GAP}px + env(safe-area-inset-bottom));
        border: 1px solid ${surface.rule}; border-radius: ${radius.pill}px;
        background: color-mix(in srgb, ${surface.card} 82%, transparent);
        -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
        box-shadow: ${shadow.float};
      }
      .tabbar > a {
        flex: 1 1 0; min-width: 0; flex-direction: column; justify-content: center; gap: 2px; height: auto; padding: 0 2px;
        border-radius: ${radius.pill}px; color: ${ink.muted}; font-size: 11px; white-space: nowrap;
      }
      .tabbar > a[aria-current="page"] { background: ${surface.sunken}; color: ${ink.strong}; }
      .tab-dot { top: 8px; left: calc(50% + 6px); box-shadow: 0 0 0 2px ${surface.card}; }


      /* The phone says enough on its own. */
      .call-label { display: none; }

      .call-panel { left: 12px; right: 12px; width: auto; bottom: calc(${TABBAR_HEIGHT + TABBAR_GAP + 12}px + env(safe-area-inset-bottom)); }
      .call-stage { top: 12px; left: 12px; }
      .call-stack { left: 12px; right: 12px; width: auto; top: 12px; }
      .graph-canvas { height: min(600px, 65dvh); }
      .collection-tools { width: 100%; }
      .collection-search { flex: 1 1 100%; width: auto; }

      /* A dialog rises from the bottom edge, where a thumb can reach it. */
      .modal-backdrop { align-items: flex-end !important; padding: 0 !important; }
      .modal {
        max-width: none !important;
        max-height: 92dvh;
        border-radius: ${radius.lg}px !important;
        padding-bottom: calc(24px + env(safe-area-inset-bottom)) !important;
        animation: minca-sheet .2s ease !important;
      }

      /* Floating panels are anchored to what opened them, which on a phone
         can be near an edge; pinned to the bottom instead, they always fit. */
      .popover {
        position: fixed !important;
        top: auto !important;
        left: 16px !important;
        right: 16px;
        bottom: calc(16px + env(safe-area-inset-bottom));
        width: auto !important;
        font-size: 14px !important;
      }

      /* A panel that drops from a button in the top bar spans the screen
         under the bar, so it never runs off the side it wasn't anchored to. */
      .drop {
        position: fixed !important;
        top: calc(64px + env(safe-area-inset-top)) !important;
        bottom: auto !important;
        left: max(12px, env(safe-area-inset-left)) !important;
        right: max(12px, env(safe-area-inset-right)) !important;
        width: auto !important;
        max-width: none !important;
        max-height: calc(100dvh - 160px);
        overflow-y: auto !important;
      }

      /* Two labels beside each other leave too little room for the value. */
      .property { grid-template-columns: minmax(0, 1fr) !important; gap: 2px !important; }
      .property > dt { padding-top: 0 !important; }
    }

    /* No hover to bring up a message's actions: they wait for a tap on it,
       so the text gets the whole width the rest of the time. */
    .chat-line:focus { outline: none; }
    @media (hover: none) {
      .chat-line [data-row-action] { display: none; }
      .chat-line:focus-within { background-color: ${surface.sunken}; }
      .chat-line:focus-within [data-row-action] { display: inline-flex; align-items: center; opacity: 1; }
    }

    /* Fingers, not a mouse: bigger targets (fields are raised to 16px in baseCss). */
    @media (pointer: coarse) {
      input:not([type="checkbox"]):not([type="radio"]), select { min-height: 40px; }
      button[data-variant], [role="tab"], [data-nav], [data-menu-item] { min-height: 40px; }
      [data-row-action] { min-width: 36px; min-height: 36px; }
      /* Grown to a finger's size in both directions, so it stays round. */
      [data-round] { width: 40px !important; height: 40px !important; }
      /* The query editor and a box you can mention in are see-through fields over a highlighted copy; both change size together or the caret drifts off the text. */
      .code-layer, .mention-layer { font-size: 16px !important; }
    }

    @keyframes minca-sheet { from { transform: translateY(100%) } to { transform: none } }
  `;
  globalThis.document.head.appendChild(style);
}

const quietButton: CSSProperties = {
  ...styles.button,
  backgroundColor: surface.card,
  borderColor: surface.rule,
  color: ink.strong,
};

/** Quieter alternatives, for actions that should not compete with the main one. */
export const variants = {
  quiet: quietButton,
  danger: { ...quietButton, color: accent.danger },
} satisfies Record<string, CSSProperties>;

const line = `1px solid ${surface.line}`;

/**
 * Pieces many views share: a pill, a table's cells, a bordered card, a
 * clipped line. The chip and the card are the shared ones
 * (`styles.chip`, `styles.tile`); the chip is spelled in longhands here so a
 * chip that is on can change its colour alone.
 */
export const ui = {
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: styles.chip.gap,
    height: styles.chip.height,
    padding: styles.chip.padding,
    borderRadius: styles.chip.borderRadius,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: surface.line,
    background: styles.chip.backgroundColor,
    color: styles.chip.color,
    fontSize: styles.chip.fontSize,
    fontWeight: styles.chip.fontWeight,
    whiteSpace: 'nowrap',
  },
  /** On: the rule, as a chosen segment has (`styles.chipOn`) */
  chipOn: { borderColor: surface.rule, color: ink.strong },
  th: {
    textAlign: 'left',
    padding: '10px 14px',
    borderBottom: line,
    color: ink.muted,
    fontWeight: 500,
    fontSize: 12,
    background: surface.sunken,
  },
  td: { padding: '10px 14px', borderBottom: line, color: ink.body },
  /** Around a table, which scrolls sideways inside it when too wide */
  tableBox: { border: `1px solid ${surface.rule}`, borderRadius: radius.lg, overflowX: 'auto' },
  card: styles.tile,
  list: styles.list,
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
} satisfies Record<string, CSSProperties>;
