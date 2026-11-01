/**
 * A phone draws the whole app a little larger, the way a browser's page zoom does: the page is laid out
 * as if the screen were a little narrower, then scaled up to fill it. Text, icons and spacing grow
 * together, and nothing is laid out for a width it doesn't have. Only on a touchscreen in portrait as
 * narrow as a phone's; a tablet, a phone on its side and every window with a mouse keep their size.
 */

/** How much larger at most */
const MOST = 1.15;
/** The narrowest the page is ever laid out for: a small phone scales less, so its page is no narrower */
const NARROWEST = 340;
/** What the page's own viewport says besides its width and scale, as index.html has it */
const REST = 'viewport-fit=cover, interactive-widget=resizes-content';

function apply(meta: HTMLMetaElement): void {
  // iOS gives the portrait width as the screen's width however the phone is held; Android turns it.
  const portrait = globalThis.matchMedia('(orientation: portrait)').matches;
  const { width, height } = globalThis.screen;
  const across = portrait ? Math.min(width, height) : Math.max(width, height);
  const phone = globalThis.matchMedia('(pointer: coarse)').matches && portrait && across <= 500;
  const scale = phone ? Math.min(MOST, across / NARROWEST) : 1;
  meta.content =
    scale > 1.01
      ? `width=${Math.round(across / scale)}, initial-scale=${scale.toFixed(3)}, ${REST}`
      : `width=device-width, initial-scale=1.0, ${REST}`;
}

/** Sets the page's viewport for this screen, and again whenever the phone is turned */
export function scaleForPhone(): void {
  const meta = globalThis.document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  apply(meta);
  globalThis.matchMedia('(orientation: portrait)').addEventListener('change', () => apply(meta));
}
