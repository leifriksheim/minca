/**
 * How much of the screen is showing, kept as `--visible-height` on the page.
 *
 * A phone's keyboard covers the page rather than shrinking it on iOS, so an open
 * app sized to the screen (`100dvh`) keeps its last line, a chat's message box,
 * under the keyboard. The visual viewport is what is left above it; an open app
 * is pinned to it, where it is (`--visible-top`) and as tall (`styles.ts`), and
 * the bar at its foot steps aside while a keyboard is up (`data-keyboard`). Chrome on Android shrinks the page itself
 * (`interactive-widget` in `index.html`), and then the two agree.
 */
export function followVisibleHeight(): void {
  const seen = globalThis.visualViewport;
  if (!seen) return;
  const root = globalThis.document.documentElement;
  const follow = () => {
    root.style.setProperty('--visible-height', `${seen.height}px`);
    // Safari also slides what is visible down the page to bring the field into view, a field in an
    // app's frame too, without scrolling the page itself. An open app is pinned where it slid to.
    root.style.setProperty('--visible-top', `${seen.offsetTop}px`);
    // A keyboard is up when much less than the window shows: the bar at an open app's foot gives way.
    root.toggleAttribute('data-keyboard', globalThis.innerHeight - seen.height > 120);
    if (globalThis.document.querySelector('[data-app-open]') && globalThis.scrollY !== 0)
      globalThis.scrollTo(0, 0);
  };
  seen.addEventListener('resize', follow);
  seen.addEventListener('scroll', follow);
  follow();
}
