import type { CSSProperties } from 'react';
import { baseCss, hoverCss, hstack, palette, stack, styles } from '@minca/app-shared/styles';

export { hstack, palette, stack, styles };

const { ink, surface, accent, radius, shadow } = palette;

/** A navy wash over what is behind it, for overlays and labels on video */
const navyWash = (percent: number) => `color-mix(in srgb, ${ink.strong} ${percent}%, transparent)`;

/** How tall the bar along a phone's bottom edge is, with room under it */
const TABBAR_HEIGHT = 68;
/** How wide a space's rail of apps is */
const RAIL_WIDTH = 80;

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
      .you-button:hover, .you-button[aria-expanded="true"],
      .group-button:hover, .group-button[aria-expanded="true"] { background: ${surface.line} !important; }
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
      position: relative; z-index: 15; display: flex; flex-direction: column; min-height: 0; padding: 10px 6px;
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
    .rail-top { flex-shrink: 0; display: flex; justify-content: center; padding-bottom: 8px; margin-bottom: 6px; border-bottom: 1px solid ${surface.line}; }
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
      position: relative; flex-shrink: 0; padding-top: 8px; display: flex; flex-direction: column; align-items: center; gap: 8px;
      border-top: 1px solid ${surface.line};
    }
    .you-button {
      display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0;
      border: none; border-radius: ${radius.pill}px; background: none;
    }
    .side-item {
      display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px;
      border: none; border-radius: ${radius.pill}px; background: none; font-size: 14px; text-align: left;
    }
    .side-item[aria-current] { background: ${surface.card}; box-shadow: 0 0 0 1px ${surface.rule}; }
    .space-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    /* A phone's bar along the foot of a space (below); a wide screen has the rail. */
    .space-foot { display: none; }
    .space-bar {
      flex-shrink: 0; display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 24px;
      border-bottom: 1px solid ${surface.rule}; background: ${surface.page};
    }
    .space-content { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 32px 64px; }
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
      background: ${surface.scrim};
    }
    .call-incoming { width: min(340px, 100%); align-items: center; text-align: center; gap: 16px; padding: 24px; }
    .call-ringing { display: inline-flex; border-radius: 50%; animation: call-ring 1.2s ease-out infinite; }
    @keyframes call-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, ${accent.good} 45%, transparent); } 100% { box-shadow: 0 0 0 12px transparent; } }
    @media (prefers-reduced-motion: reduce) { .call-ringing { animation: none; } }

    /* Chat: its channels and conversations down the left, the one open beside them. */
    .chat-shell { display: grid; grid-template-columns: 208px minmax(0, 1fr); }
    .chat-places {
      display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
      padding: 4px 8px 12px; border-right: 1px solid ${surface.line}; background: ${surface.sunken};
    }
    .chat-places [data-nav]:not([aria-current]):hover { background: ${surface.line} !important; }

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

    /* Between a phone and a laptop, the chat's list becomes a row of tabs
       above it, as the side column's does. A phone gives each a screen (below). */
    @media (min-width: 641px) and (max-width: 760px) {
      .chat-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .chat-places {
        flex-direction: row; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none;
        padding: 6px 8px; border-right: none; border-bottom: 1px solid ${surface.line};
      }
      .chat-places::-webkit-scrollbar { display: none; }
      .chat-places > * { flex-shrink: 0; width: auto !important; }
      .chat-places-heading { padding: 0 2px 0 6px !important; }
      .chat-places-heading > span, .chat-places-note { display: none; }
    }

    @media (max-width: 640px) {
      .page {
        padding: 12px max(16px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      /* Room under the last row for the bar along the bottom. */
      .page:has(> * > .tabbar) { padding-bottom: calc(${TABBAR_HEIGHT + 48}px + env(safe-area-inset-bottom)); }

      /* A phone switches spaces from the list of them, one tap away in the
         tab bar, so the space's own sections get the bottom edge, and its
         apps are the grid on the first screen rather than a sidebar. */
      .app-rail, .hide-on-phone, .bar-label { display: none !important; }
      .space-foot {
        position: sticky; bottom: 0; z-index: 8; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
        min-height: 56px; padding: 0 max(12px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(12px, env(safe-area-inset-left));
        border-top: 1px solid ${surface.rule}; background: ${surface.page};
      }
      .space-foot > :first-child { flex: 1; min-width: 0; }
      /* A panel that rises from the bar at the foot spans the screen above it, as one from the top bar drops under it. */
      .rise {
        position: fixed !important;
        top: auto !important;
        bottom: calc(64px + env(safe-area-inset-bottom)) !important;
        left: max(12px, env(safe-area-inset-left)) !important;
        right: max(12px, env(safe-area-inset-right)) !important;
        width: auto !important;
        max-height: calc(100dvh - 160px);
        overflow-y: auto !important;
      }
      .phone-only { display: revert !important; }
      .segmented.phone-only { display: flex !important; }
      .space-shell { display: block; height: auto; min-height: 100dvh; }
      /* At least the screen's height, the content taking what is spare, so the bar at the foot sits at the bottom of a short page too. */
      .space-main { min-height: 100dvh; }
      .space-content { flex: 1 0 auto; }
      .space-bar {
        position: sticky; top: 0; z-index: 8; height: auto; min-height: 56px; gap: 8px;
        padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
        background: ${surface.page};
      }
      .space-content {
        overflow: visible;
        padding: 16px max(16px, env(safe-area-inset-right)) calc(100px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      /* An open app is the whole screen, with the way back at its top, as a conversation is on a phone. */
      .space-shell[data-app-open] .space-content { overflow-y: auto; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
      /* As tall as what shows above the keyboard, once one is up (viewport.ts), so a chat's box stays in view. */
      .space-shell[data-app-open] { min-height: 0; height: var(--visible-height, 100dvh); overflow: hidden; }
      .space-shell[data-app-open] .space-main { display: flex; height: var(--visible-height, 100dvh); }
      .space-shell[data-app-open] .space-bar { position: static; }
      .space-content[data-fill], .space-shell[data-app-open] .space-content[data-fill] { padding: 0 0 env(safe-area-inset-bottom); }

      /* Chat, the way a phone's messaging apps are: the list of conversations
         is a screen, and one opens over it with the way back at its top. */
      .chat-shell { grid-template-columns: minmax(0, 1fr); }
      .chat-shell[data-view="list"] > .chat-room, .chat-shell[data-view="room"] > .chat-places { display: none !important; }
      .chat-places { padding: 8px 12px 24px; border-right: none; background: none; }
      .chat-places [data-nav] { height: 48px !important; padding: 0 12px !important; gap: 10px !important; font-size: 16px !important; }
      .chat-places-heading { padding: 10px 2px 2px 12px !important; }
      .chat-places-heading > span { font-size: 13px !important; }
      .chat-places-heading > button { padding: 10px !important; }
      .chat-shell[data-view="list"] .chat-places [aria-current] { background: none !important; box-shadow: none !important; font-weight: 400 !important; }
      .chat-places-note { padding: 4px 12px !important; font-size: 13px !important; }
      .chat-places-form > input { height: 40px !important; font-size: 16px !important; }
      .chat-places-form > button { height: 40px !important; }
      .chat-room-title { min-height: 48px; padding: 8px 14px !important; }

      .tabbar {
        position: fixed; z-index: 10; left: 0; right: 0; bottom: 0; width: auto; margin: 0; gap: 0;
        padding: 6px max(4px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
        border: none; border-top: 1px solid ${surface.rule}; border-radius: 0; background: ${surface.page};
      }
      .tabbar > a {
        flex: 1 1 0; min-width: 0; flex-direction: column; gap: 3px; height: auto; padding: 6px 2px;
        color: ${ink.faint}; font-size: 11px; white-space: nowrap;
      }
      .tabbar > a[aria-current="page"] { background: none; color: ${ink.strong}; }
      .tab-dot { top: 4px; left: calc(50% + 6px); box-shadow: 0 0 0 2px ${surface.page}; }


      /* The phone says enough on its own. */
      .call-label { display: none; }

      .call-panel { left: 12px; right: 12px; width: auto; bottom: calc(${TABBAR_HEIGHT + 12}px + env(safe-area-inset-bottom)); }
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
