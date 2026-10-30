import type { CSSProperties } from 'react';
import { baseCss, hoverCss, hstack, palette, stack, styles } from '@minca/app-shared/styles';

export { hstack, palette, stack, styles };

const { ink, surface, accent, radius, shadow } = palette;

/** A navy wash over what is behind it, for overlays and labels on video */
const navyWash = (percent: number) => `color-mix(in srgb, ${ink.strong} ${percent}%, transparent)`;

/** How wide the column of spaces is, down the left edge while one is open. */
const RAIL_WIDTH = 68;
/** How wide a space's own sidebar is, beside the rail */
const SIDEBAR_WIDTH = 248;

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
      .you-button:hover, .you-button[aria-expanded="true"] { background: ${surface.line}; }
    }

    /* ── Layout that follows the screen ──────────────────────────────────
       One breakpoint for "phone" (640px) and one for "too narrow for a side
       column" (760px). Touch is asked about separately, with pointer: coarse,
       since a small laptop window is not a phone and a tablet is not a mouse. */

    /* .page and .space-layout come from baseCss: the home's screens sit on the same page. */

    /* In a space: the rail, the space's sidebar, and whatever is open, each
       the height of the window and scrolling on its own, the way chat apps are. */

    .shell { padding-left: ${RAIL_WIDTH}px; }
    .space-shell { display: grid; grid-template-columns: ${SIDEBAR_WIDTH}px minmax(0, 1fr); height: 100vh; height: 100dvh; }
    .space-sidebar {
      display: flex; flex-direction: column; min-height: 0;
      background: ${surface.sunken}; border-right: 1px solid ${surface.rule};
    }
    .space-sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 16px 10px 16px; }
    /* You, at the foot of the sidebar; its menus open upward from it. */
    .you-bar {
      position: relative; z-index: 15; flex-shrink: 0; display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; border-top: 1px solid ${surface.line}; background: ${surface.sunken};
    }
    .you-button {
      width: 100%; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 6px;
      border: none; border-radius: ${radius.pill}px; background: none; text-align: left;
    }
    .side-item {
      display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px;
      border: none; border-radius: ${radius.pill}px; background: none; font-size: 14px; text-align: left;
    }
    .side-item[aria-current] { background: ${surface.card}; box-shadow: 0 0 0 1px ${surface.rule}; }
    .space-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
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
    .rail-count, .app-card-count, .tab-count { position: absolute; pointer-events: none; }
    .rail-count { top: -2px; right: 8px; }
    .rail-count .count { box-shadow: 0 0 0 2px ${surface.sunken}; }
    .app-card-count { top: -6px; right: -6px; }
    .app-card-count .count, .tab-count .count { box-shadow: 0 0 0 2px ${surface.card}; }
    .tab-count { top: -4px; right: -10px; }

    /* Every space down the left edge; along the bottom on a phone. */
    .rail {
      position: fixed;
      z-index: 10;
      top: 0;
      bottom: 0;
      left: 0;
      width: ${RAIL_WIDTH}px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 16px 0;
      background: ${surface.sunken};
      border-right: 1px solid ${surface.rule};
    }
    /* In the desktop app's window (apps/desktop), which has no title bar: room for its buttons. */
    :root[data-desktop] .rail { padding-top: 44px; }
    .rail-list { display: flex; flex-direction: column; align-items: center; gap: 8px; overflow-y: auto; flex: 0 1 auto; width: 100%; }
    .rail-divider { flex-shrink: 0; width: 28px; height: 1px; margin: 4px 0; background: ${surface.line}; }
    .rail-slot { position: relative; flex-shrink: 0; width: 100%; display: flex; justify-content: center; padding: 2px 0; border: none; background: none; }

    /* A row that scrolls sideways instead of wrapping, with no scrollbar in the way. */
    .scroll-x { overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .scroll-x::-webkit-scrollbar { display: none; }
    .scroll-x > * { flex-shrink: 0; white-space: nowrap; }

    /* Rows in a list, one surface: a hairline between each, none round the edge (ui.list). */
    .rows > li + li { border-top: 1px solid ${surface.line}; }

    /* A space: its collections down the side, the chosen one beside them. */
    .space-side { display: flex; flex-direction: column; gap: 28px; }
    .collection-nav { display: flex; flex-direction: column; gap: 2px; }

    /* A space's apps, like a phone's home screen: cards on a wide screen,
       icons on a narrow one. */
    .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .app-list { display: flex; flex-direction: column; gap: 8px; }

    /* Views that sit side by side under one heading, like Under the hood's. */
    .segmented { display: flex; gap: 2px; align-self: flex-start; max-width: 100%; padding: 4px; border-radius: ${radius.pill}px; background: ${surface.sunken}; }
    .segmented > button {
      display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px;
      border: 1px solid transparent; border-radius: ${radius.pill}px; background: none; color: ${ink.muted}; font-size: 13px; font-weight: 500;
    }
    .segmented > button:hover { color: ${ink.strong}; }
    .segmented > button[aria-selected="true"] { background: ${surface.card}; border-color: ${surface.rule}; color: ${ink.strong}; }

    /* A space's sections along the bottom, and the button that makes an
       app: phones only. */
    .tabbar, .fab { display: none; }

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
      top: 20px; left: ${RAIL_WIDTH + 20}px; width: auto;
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
        padding: 20px max(16px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }

      /* A phone switches spaces from the list of them, one tap away in the
         tab bar, so the space's own sections get the bottom edge, and its
         apps are the grid on the first screen rather than a sidebar. */
      .rail, .space-sidebar, .hide-on-phone, .bar-label { display: none !important; }
      .phone-only { display: revert !important; }
      .segmented.phone-only { display: flex !important; }
      .shell { padding-left: 0; }
      .space-shell { display: block; height: auto; min-height: 100dvh; }
      .space-bar {
        position: sticky; top: 0; z-index: 8; height: auto; min-height: 56px; gap: 8px;
        padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
        background: ${surface.page};
      }
      .space-content {
        overflow: visible;
        padding: 16px max(16px, env(safe-area-inset-right)) calc(${RAIL_WIDTH + 100}px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      /* An open app is the whole screen, with the way back at its top, as a conversation is on a phone. */
      .space-shell[data-app-open] .tabbar { display: none; }
      .space-shell[data-app-open] .space-content { overflow-y: auto; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
      .space-shell[data-app-open] .space-main { display: flex; height: 100dvh; }
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
        position: fixed;
        z-index: 10;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        padding: 6px max(4px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
        background: ${surface.page};
        border-top: 1px solid ${surface.rule};
      }
      .tabbar > button {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 6px 2px;
        border: none;
        background: none;
        color: ${ink.faint};
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
      }
      .tabbar > button[aria-current] { color: ${accent.base}; }

      .fab {
        position: fixed;
        z-index: 9;
        right: max(16px, env(safe-area-inset-right));
        bottom: calc(${RAIL_WIDTH + 12}px + env(safe-area-inset-bottom));
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 48px;
        padding: 0 18px;
        border: 1px solid ${surface.rule};
        border-radius: ${radius.pill}px;
        background: ${accent.base};
        color: ${surface.card};
        font-size: 15px;
        font-weight: 600;
        box-shadow: ${shadow.small};
      }

      /* Three icons to a row, named underneath, the way a phone lays out apps. */
      .app-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 8px; }
      .app-card { flex-direction: column !important; align-items: center !important; gap: 8px !important; padding: 4px 0 !important; border: none !important; background: none !important; text-align: center !important; box-shadow: none !important; }
      .app-card .app-card-icon { width: 56px !important; height: 56px !important; }
      .app-card strong { font-size: 13px !important; font-weight: 500 !important; }
      .app-card-text { display: none; }

      /* The avatar and the phone say enough on their own. */
      .account-name, .call-label { display: none; }
      .account-button { padding: 0 3px !important; }

      .call-panel { left: 12px; right: 12px; width: auto; bottom: calc(${RAIL_WIDTH + 12}px + env(safe-area-inset-bottom)); }
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
  /** A list on the page: one card, its rows ruled by hairlines (give it className="rows") */
  list: { ...styles.tile, padding: 0, margin: 0, overflow: 'hidden' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
} satisfies Record<string, CSSProperties>;
