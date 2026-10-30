/**
 * How much of the screen is showing, kept as `--visible-height` on the page.
 *
 * A phone's keyboard covers the page rather than shrinking it on iOS, so an open
 * app sized to the screen (`100dvh`) keeps its last line, a chat's message box,
 * under the keyboard. The visual viewport is what is left above it; an open app
 * is that tall instead (`styles.ts`). Chrome on Android shrinks the page itself
 * (`interactive-widget` in `index.html`), and then the two agree.
 */
export function followVisibleHeight(): void {
  const seen = globalThis.visualViewport;
  if (!seen) return;
  const root = globalThis.document.documentElement;
  const follow = () => {
    root.style.setProperty('--visible-height', `${seen.height}px`);
    // Safari also slides the page up to bring the field into view. An open app already fits
    // what is visible, so the page goes back to the top and the app scrolls inside itself.
    if (globalThis.document.querySelector('[data-app-open]') && globalThis.scrollY !== 0)
      globalThis.scrollTo(0, 0);
  };
  seen.addEventListener('resize', follow);
  seen.addEventListener('scroll', follow);
  follow();
}
