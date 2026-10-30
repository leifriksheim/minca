/**
 * @module session/popup
 * Where a window opened over a page goes, as sign-in windows do: its size, and
 * the middle of the browser window it was opened from. Given a size alone, a
 * browser puts it wherever it likes, often in the screen's top left corner.
 */

/**
 * The features for `window.open` that make a popup of this size, centred on the
 * window it opens from. Off a browser, where there is no window to centre on,
 * just the size.
 */
export function popupFeatures(width: number, height: number): string {
  const size = `popup,width=${width},height=${height}`;
  const { screenX, screenY, outerWidth, outerHeight } = globalThis;
  if (![screenX, screenY, outerWidth, outerHeight].every((n) => typeof n === 'number' && Number.isFinite(n)))
    return size;
  const left = Math.max(0, Math.round(screenX + (outerWidth - width) / 2));
  const top = Math.max(0, Math.round(screenY + (outerHeight - height) / 2));
  return `${size},left=${left},top=${top}`;
}
