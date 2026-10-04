/**
 * Finding places by name, and naming where you are: OpenStreetMap's data
 * through Photon (photon.komoot.io), which is built for search as you type
 * and answers a browser directly. Nothing here is Weave: a place found is
 * written into a record as plain `lat`, `lon` and address, and nobody else
 * needs to ask the same service.
 *
 * The public instance is free for fair use, with no key. Set
 * `VITE_WEAVE_PLACES` to your own (Photon is open source) before a lot of
 * people use a deployment. OpenStreetMap's licence asks that results say
 * where they came from: show {@link PLACES_CREDIT} beside them.
 */

const SERVICE = (import.meta.env.VITE_WEAVE_PLACES ?? 'https://photon.komoot.io').replace(/\/+$/, '');

/** What results must credit, under the ODbL */
export const PLACES_CREDIT = '© OpenStreetMap contributors';
export const PLACES_CREDIT_URL = 'https://www.openstreetmap.org/copyright';

/** A place as a search finds it */
export interface FoundPlace {
  /** Its own name, or else its street address */
  readonly name: string;
  /** A line under the name: the street, the area, the town, the country */
  readonly detail: string;
  readonly street?: string;
  /** The town or city */
  readonly locality?: string;
  /** The part of town: a district or neighbourhood */
  readonly area?: string;
  readonly postcode?: string;
  /** ISO 3166-1 alpha-2, upper case */
  readonly country?: string;
  readonly lat: number;
  readonly lon: number;
  /** What it is, as OpenStreetMap types it: `house`, `street`, `district`, `city`… */
  readonly kind: string;
}

/**
 * Places matching what someone typed, the nearest first when `near` is given.
 * Empty for fewer than three characters; throws when the service can't be
 * reached, so a form can say so.
 */
export async function searchPlaces(
  text: string,
  options: { near?: { lat: number; lon: number }; limit?: number; signal?: AbortSignal } = {},
): Promise<FoundPlace[]> {
  const q = text.trim();
  if (q.length < 3) return [];
  const params = new URLSearchParams({ q, limit: String(options.limit ?? 6), lang: language() });
  if (options.near) {
    params.set('lat', options.near.lat.toFixed(4));
    params.set('lon', options.near.lon.toFixed(4));
  }
  return found(await ask(`${SERVICE}/api/?${params}`, options.signal));
}

/** What is at a point, to name it: the nearest address or place */
export async function placeAt(lat: number, lon: number, signal?: AbortSignal): Promise<FoundPlace | null> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), limit: '1', lang: language() });
  return found(await ask(`${SERVICE}/reverse?${params}`, signal))[0] ?? null;
}

/** Where this device is, if the person lets the page know; null when they don't or it can't tell */
export function whereAmI(): Promise<{ lat: number; lon: number } | null> {
  const geo = globalThis.navigator?.geolocation;
  if (!geo) return Promise.resolve(null);
  return new Promise((resolve) =>
    geo.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    ),
  );
}

async function ask(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`The place search answered ${response.status}`);
  return response.json();
}

/** Photon's languages; anything else gets each place's own name */
const LANGUAGES = new Set(['en', 'de', 'fr', 'it']);
const language = () => {
  const lang = (globalThis.navigator?.language ?? 'en').slice(0, 2).toLowerCase();
  return LANGUAGES.has(lang) ? lang : 'default';
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Photon's GeoJSON, as places; anything malformed is skipped */
function found(json: unknown): FoundPlace[] {
  const features = isObject(json) && Array.isArray(json.features) ? json.features : [];
  const out: FoundPlace[] = [];
  for (const feature of features) {
    if (!isObject(feature) || !isObject(feature.properties) || !isObject(feature.geometry)) continue;
    const coordinates: unknown = feature.geometry.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const lon: unknown = coordinates[0];
    const lat: unknown = coordinates[1];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const p = feature.properties;
    const street = [str(p.street), str(p.housenumber)].filter(Boolean).join(' ') || undefined;
    const locality = str(p.city) ?? str(p.town) ?? str(p.village) ?? str(p.district) ?? str(p.locality);
    const area = str(p.district) ?? str(p.locality);
    const name = str(p.name) ?? street ?? locality ?? str(p.county) ?? str(p.state) ?? str(p.country);
    if (!name) continue;
    const code = str(p.countrycode)?.toUpperCase();
    const detail = [
      street !== name ? street : undefined,
      area !== name ? area : undefined,
      locality,
      str(p.country),
    ]
      .filter((part, i, all): part is string => !!part && part !== name && all.indexOf(part) === i)
      .join(', ');
    out.push({
      name,
      detail,
      ...(street ? { street } : {}),
      ...(locality ? { locality } : {}),
      ...(area ? { area } : {}),
      ...(str(p.postcode) ? { postcode: str(p.postcode) } : {}),
      ...(code && code.length === 2 ? { country: code } : {}),
      lat,
      lon,
      kind: str(p.type) ?? 'place',
    });
  }
  return out;
}
