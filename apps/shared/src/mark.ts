import { shapeColours } from './tokens';

/**
 * Minca's mark: a rainbow of four bands, four hands making one bridge, on a
 * 24 × 13 canvas. Plain data, so pages without React (the extension) draw the
 * same one `Wordmark.tsx` does.
 */
export const MARK_VIEWBOX = '0 0 24 13';

/** One band of the rainbow, standing on the line y = 12.5 */
const band = (outer: number, inner: number) =>
  `M${12 - outer} 12.5A${outer} ${outer} 0 0 1 ${12 + outer} 12.5` +
  (inner > 0 ? `H${12 + inner}A${inner} ${inner} 0 0 0 ${12 - inner} 12.5Z` : 'Z');

/** The bands, outside in */
export const MARK_BANDS: ReadonlyArray<{ d: string; fill: string }> = [
  { d: band(11.5, 8.75), fill: shapeColours.cobalt },
  { d: band(8.75, 6), fill: shapeColours.coral },
  { d: band(6, 3.25), fill: shapeColours.peach },
  { d: band(3.25, 0), fill: shapeColours.sage },
];
