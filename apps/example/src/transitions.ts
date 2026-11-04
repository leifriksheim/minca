/**
 * How a move between pages looks (`defaultViewTransition` in `router.tsx`, the animations in
 * `app.css`): going in, from home to a space or from an app to the space's own pages, slides forward;
 * coming back slides back; the home's tabs, and one app for another, cross-fade. A change that keeps
 * the page, like a record opened beside it, moves nothing.
 */
import type { ParsedLocation } from '@tanstack/react-router';

type Place = { readonly kind: 'home' } | { readonly kind: 'app' | 'aside'; readonly space: string };

/** Where a path is: home's tabs, an app in a space, or any other of a space's pages */
function placeOf(path: string): Place {
  const [, first, space, part] = path.split('/');
  if (first !== 'spaces' || !space) return { kind: 'home' };
  return { kind: part === 'apps' ? 'app' : 'aside', space };
}

export function transitionTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: {
  fromLocation?: ParsedLocation;
  toLocation: ParsedLocation;
  pathChanged: boolean;
}): Array<string> | false {
  if (!pathChanged || !fromLocation) return false;
  const from = placeOf(fromLocation.pathname);
  const to = placeOf(toLocation.pathname);
  if (from.kind === 'home' && to.kind === 'home') return ['fade'];
  // The browser's Back, or this app's, which goes back in history too.
  if (toLocation.state.__TSR_index < fromLocation.state.__TSR_index) return ['back'];
  if (to.kind === 'home') return ['back'];
  if (from.kind === 'home') return ['forward'];
  if (from.space !== to.space || (from.kind === 'app' && to.kind === 'app')) return ['fade'];
  return ['forward'];
}
