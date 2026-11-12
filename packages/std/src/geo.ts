/**
 * Where things are, as something a keeper can match without reading.
 *
 * A place in a standard record carries `lat` and `lon`, and with them
 * `cells`: the geohash cells the point is in, one for each precision in
 * {@link CELL_PRECISIONS}. Collections name `place.cells` as a topic, so each
 * cell becomes a blind tag (spec 02 §8), and "listings near here" is a match
 * on a handful of cells: equality only, which is all a tag can do. The exact
 * distance is worked out afterwards, from `lat` and `lon`, by whoever reads
 * the body.
 *
 * Geohash, after Niemeyer (2008): longitude and latitude bits interleaved,
 * longitude first, five to a character of its own base 32 alphabet. A cell's
 * name is a prefix of every cell inside it.
 */

const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/** The precisions a place's `cells` hold, coarsest first: about 156 km, 39 km, 4.9 km and 1.2 km across */
export const CELL_PRECISIONS = [3, 4, 5, 6] as const;

/** Kilometres in a degree of latitude, on a sphere of the Earth's mean radius */
const KM_PER_DEGREE = (Math.PI * 6371.0088) / 180;

/** The geohash of a point, `precision` characters long (1–12) */
export function geohash(lat: number, lon: number, precision: number): string {
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new RangeError('A geohash is 1 to 12 characters');
  }
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
    throw new RangeError('Latitude is −90 to 90 and longitude −180 to 180');
  }
  const range = { lat: [-90, 90], lon: [-180, 180] };
  let out = '';
  let bits = 0;
  let value = 0;
  let even = true;
  while (out.length < precision) {
    const [low, high] = even ? range.lon : range.lat;
    const mid = (low! + high!) / 2;
    const at = even ? lon : lat;
    value = (value << 1) | (at >= mid ? 1 : 0);
    if (at >= mid) (even ? range.lon : range.lat)[0] = mid;
    else (even ? range.lon : range.lat)[1] = mid;
    even = !even;
    if (++bits === 5) {
      out += ALPHABET[value];
      bits = 0;
      value = 0;
    }
  }
  return out;
}

/** The box a geohash names, in degrees */
export interface Cell {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** The box a geohash names; throws on a character outside its alphabet */
export function cellOf(hash: string): Cell {
  const lat = [-90, 90];
  const lon = [-180, 180];
  let even = true;
  for (const char of hash.toLowerCase()) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new RangeError(`"${char}" is not a geohash character`);
    for (let bit = 4; bit >= 0; bit--) {
      const range = even ? lon : lat;
      const mid = (range[0]! + range[1]!) / 2;
      range[(value >> bit) & 1 ? 0 : 1] = mid;
      even = !even;
    }
  }
  return { south: lat[0]!, west: lon[0]!, north: lat[1]!, east: lon[1]! };
}

/** The middle of a geohash's box */
export function centreOf(hash: string): { lat: number; lon: number } {
  const cell = cellOf(hash);
  return { lat: (cell.south + cell.north) / 2, lon: (cell.west + cell.east) / 2 };
}

/**
 * A cell and the eight around it, at the cell's own precision, each once.
 * Longitude wraps at ±180°; past a pole there is nothing, so a cell at the
 * edge has fewer.
 */
export function aroundCell(hash: string): string[] {
  const cell = cellOf(hash);
  const height = cell.north - cell.south;
  const width = cell.east - cell.west;
  const { lat, lon } = centreOf(hash);
  const out = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    const y = lat + dLat * height;
    if (y < -90 || y > 90) continue;
    for (const dLon of [-1, 0, 1]) {
      const x = ((((lon + dLon * width + 180) % 360) + 360) % 360) - 180;
      out.add(geohash(y, x, hash.length));
    }
  }
  return [...out];
}

/** What a place's `cells` hold for a point: its cell at each of {@link CELL_PRECISIONS} */
export const cellsOf = (lat: number, lon: number): string[] =>
  CELL_PRECISIONS.map((precision) => geohash(lat, lon, precision));

/** The distance between two points along the Earth's surface, in kilometres (haversine) */
export function distanceKm(
  a: { readonly lat: number; readonly lon: number },
  b: { readonly lat: number; readonly lon: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * KM_PER_DEGREE * (180 / Math.PI) * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The cells that hold everything within `radiusKm` of a point: the finest of
 * {@link CELL_PRECISIONS} whose cells are at least that wide and tall there,
 * and the eight around the point's own. Something inside the circle is in one
 * of them; not everything in them is inside the circle, so check the distance
 * too. Null when even the coarsest cells are too small (a radius over about
 * 150 km, or near a pole): then there is no shortcut, and every place is a
 * candidate.
 */
export function cellsAround(
  lat: number,
  lon: number,
  radiusKm: number,
): { precision: number; cells: string[] } | null {
  const reach = radiusKm / KM_PER_DEGREE;
  for (const precision of [...CELL_PRECISIONS].reverse()) {
    const lonBits = Math.ceil((precision * 5) / 2);
    const latBits = Math.floor((precision * 5) / 2);
    const height = 180 / 2 ** latBits;
    // A degree of longitude is shortest on the side of the circle nearest a pole.
    const nearPole = Math.min(90, Math.abs(lat) + reach);
    const width = (360 / 2 ** lonBits) * Math.cos((nearPole * Math.PI) / 180);
    if (height >= reach && width >= reach) {
      return { precision, cells: aroundCell(geohash(lat, lon, precision)) };
    }
  }
  return null;
}
