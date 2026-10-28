/**
 * Places as the standard records keep them (`std.event`'s and `std.listing`'s
 * `place`): finding one by name, showing it, how far it is, and where the
 * person is looking from. Searching and locating are done by the page around
 * the screen (`minca.places`), which may ask the person first.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { cellsAround, cellsOf, centreOf, distanceKm, geohash } from '@minca/core/schemas';
import type { FoundPlace } from './minca';
import { html } from './html';
import { Modal } from './modal';

/** A place in a record: a name, an address, a point and its cells */
export interface Place {
  readonly name?: string;
  readonly address?: { street?: string; locality?: string; postcode?: string; country?: string };
  readonly lat?: number;
  readonly lon?: number;
  readonly cells?: ReadonlyArray<string>;
}

/** Where someone is looking from, and how far */
export interface Near {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
  readonly km: number;
}

const RADII = [1, 2, 5, 10, 25, 50, 100, 250] as const;
const CREDIT = '© OpenStreetMap contributors';
const CREDIT_URL = 'https://www.openstreetmap.org/copyright';

/** A metre is plenty, and keeps a record from saying more than it means */
const round = (degrees: number) => Math.round(degrees * 1e5) / 1e5;

const hasPoint = (place: Place | undefined): place is Place & { lat: number; lon: number } =>
  typeof place?.lat === 'number' && typeof place.lon === 'number';

/**
 * A place found, as a record keeps it. `coarse` keeps only the part of town:
 * the point moves to the middle of its 1 km cell and the street is left out,
 * for a listing, where the exact spot is usually someone's home.
 */
function placeFrom(found: FoundPlace, coarse = false): Place {
  const point = coarse ? centreOf(geohash(found.lat, found.lon, 6)) : found;
  const lat = round(point.lat);
  const lon = round(point.lon);
  const name = coarse ? (found.area ?? found.locality ?? found.name) : found.name;
  const address = {
    ...(!coarse && found.street ? { street: found.street } : {}),
    ...(found.locality && found.locality !== name ? { locality: found.locality } : {}),
    ...(!coarse && found.postcode ? { postcode: found.postcode } : {}),
    ...(found.country ? { country: found.country } : {}),
  };
  return { name, ...(Object.keys(address).length ? { address } : {}), lat, lon, cells: cellsOf(lat, lon) };
}

/** Where, in one line: the place's name, then its street and town */
export function placeLabel(place: Place | undefined): string {
  if (!place) return '';
  const { name, address } = place;
  return [name, address?.street, address?.locality]
    .filter((part, i, all) => part && all.indexOf(part) === i)
    .join(', ');
}

/** How far a place is from where someone is looking, in km; null when it has no point */
export const distanceFrom = (near: Near | null, place: Place | undefined): number | null =>
  near && hasPoint(place) ? distanceKm(near, place) : null;

/** "800 m", "2.4 km", "35 km"; empty when either has no point */
export function distanceText(near: Near | null, place: Place | undefined): string {
  const km = distanceFrom(near, place);
  if (km === null) return '';
  const metres = Math.max(50, Math.round((km * 1000) / 50) * 50);
  if (metres < 1000) return `${metres} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * The part of a `where` that keeps places in reach: their cells. Undefined
 * when the circle is too big for cells to help; then distance alone decides.
 */
export function nearWhere(near: Near | null): unknown {
  if (!near) return undefined;
  const area = cellsAround(near.lat, near.lon, near.km);
  return area ? { $or: area.cells.map((cell) => ({ 'place.cells': { $contains: cell } })) } : undefined;
}

/** Whether a place is within reach: inside the circle, by its point */
export const inReach = (near: Near | null, place: Place | undefined) => {
  if (!near) return true;
  const km = distanceFrom(near, place);
  return km !== null && km <= near.km;
};

const isNear = (value: unknown): value is Near =>
  typeof value === 'object' &&
  value !== null &&
  'lat' in value &&
  typeof value.lat === 'number' &&
  'lon' in value &&
  typeof value.lon === 'number' &&
  'label' in value &&
  typeof value.label === 'string' &&
  'km' in value &&
  typeof value.km === 'number';

/** Where this person last said they're looking from, kept on their device for this app */
export function useNear(): [Near | null, (near: Near | null) => void] {
  const [near, setNear] = useState<Near | null>(null);
  useEffect(() => {
    void minca.recall('near').then((kept) => isNear(kept) && setNear(kept));
  }, []);
  return [
    near,
    (next) => {
      setNear(next);
      void minca.remember('near', next);
    },
  ];
}

/** "Open map", at OpenStreetMap, in a new tab */
export function MapLink({ place }: { place: Place | undefined }) {
  if (!hasPoint(place)) return null;
  const { lat, lon } = place;
  return html`<button
    type="button"
    data-variant="ghost"
    onClick=${() => minca.link(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`)}
  >
    Open map
  </button>`;
}

/**
 * Typing a place and picking one of what OpenStreetMap knows, or using where
 * the device is. Until a suggestion is picked, what is typed is kept as a
 * name with no point, which shows but can't be found by distance.
 */
export function PlaceField({
  value,
  onChange,
  coarse = false,
  near = null,
  placeholder,
}: {
  value: Place | undefined;
  onChange: (place: Place | undefined) => void;
  coarse?: boolean;
  near?: Near | null;
  placeholder: string;
}) {
  const [text, setText] = useState(value && !hasPoint(value) ? (value.name ?? '') : '');
  const [results, setResults] = useState<FoundPlace[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<'idle' | 'busy' | 'failed' | 'located'>('idle');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (text.trim().length < 3) return;
    let live = true;
    const timer = setTimeout(() => {
      setState('busy');
      minca.places.search(text, near ? { lat: near.lat, lon: near.lon } : undefined).then(
        (found) => {
          if (!live) return;
          setResults(found);
          setActive(0);
          setState('idle');
        },
        () => live && setState('failed'),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, near]);

  const pick = (found: FoundPlace) => {
    onChange(placeFrom(found, coarse));
    setOpen(false);
    setText('');
    setResults([]);
  };
  const here = async () => {
    setState('busy');
    const found = await minca.places.here().catch(() => null);
    if (!found) return setState('located');
    pick(found);
    setState('idle');
  };

  if (hasPoint(value)) {
    const where =
      [value.address?.street, value.address?.locality].filter(Boolean).join(', ') ||
      `${value.lat.toFixed(4)}, ${value.lon.toFixed(4)}`;
    return html`<div class="place-chosen row">
      <span aria-hidden="true">📍</span>
      <span class="stack" style="flex: 1; min-width: 0; gap: 0">
        <strong class="ellipsis">${value.name ?? 'A point on the map'}</strong>
        <span class="faint ellipsis"
          >${where}${coarse ? ' · shown as the area, not the exact spot' : ''}</span
        >
      </span>
      <button
        type="button"
        onClick=${() => {
          onChange(undefined);
          setTimeout(() => input.current?.focus());
        }}
      >
        Change
      </button>
    </div>`;
  }

  const shown = open && text.trim().length >= 3 ? results : [];
  return html`<div class="place-field">
    <div class="row">
      <input
        ref=${input}
        value=${text}
        placeholder=${placeholder}
        role="combobox"
        aria-expanded=${shown.length > 0}
        aria-autocomplete="list"
        onInput=${(event: Event) => {
          const typed = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
          setText(typed);
          setOpen(true);
          onChange(typed.trim() ? { name: typed.trim() } : undefined);
        }}
        onFocus=${() => setOpen(true)}
        onBlur=${() => setTimeout(() => setOpen(false), 150)}
        onKeyDown=${(event: KeyboardEvent) => {
          if (event.key === 'ArrowDown' && shown.length) {
            event.preventDefault();
            setActive((active + 1) % shown.length);
          } else if (event.key === 'ArrowUp' && shown.length) {
            event.preventDefault();
            setActive((active - 1 + shown.length) % shown.length);
          } else if (event.key === 'Enter' && shown[active]) {
            event.preventDefault();
            pick(shown[active]);
          } else if (event.key === 'Escape') setOpen(false);
        }}
      />
      <button
        type="button"
        data-icon
        title="Use where I am"
        aria-label="Use where I am"
        onClick=${() => void here()}
      >
        ◎
      </button>
    </div>
    ${state === 'failed' && html`<p class="faint">The place search can't be reached. What you type is kept as it is.</p>`}
    ${state === 'located' && html`<p class="faint">This browser didn't share where you are.</p>`}
    ${
      text.trim() &&
      !shown.length &&
      state === 'idle' &&
      html`<p class="faint">Pick a suggestion to put it on the map, so people nearby can find it.</p>`
    }
    ${
      shown.length > 0 &&
      html`<ul class="suggestions" role="listbox">
        ${shown.map(
          (found, i) =>
            html`<li
              key=${`${found.lat},${found.lon},${found.name}`}
              role="option"
              aria-selected=${i === active}
              onMouseDown=${(event: Event) => {
                event.preventDefault();
                pick(found);
              }}
              onMouseEnter=${() => setActive(i)}
            >
              <span class="ellipsis">${found.name}</span>
              ${found.detail && html`<span class="faint ellipsis">${found.detail}</span>`}
            </li>`,
        )}
        <li
          class="credit"
          onMouseDown=${(event: Event) => (event.preventDefault(), void minca.link(CREDIT_URL))}
        >
          ${CREDIT}
        </li>
      </ul>`
    }
  </div>`;
}

/** "Anywhere", or "Within 5 km of Grünerløkka": opens the choice of where and how far */
export function NearButton({ near, onChange }: { near: Near | null; onChange: (near: Near | null) => void }) {
  const [choosing, setChoosing] = useState(false);
  return html`<button type="button" class="chip" aria-pressed=${!!near} onClick=${() => setChoosing(true)}>
      <span aria-hidden="true">📍</span>
      <span class="ellipsis">${near ? `Within ${near.km} km of ${near.label}` : 'Anywhere'}</span>
    </button>
    ${
      choosing &&
      html`<${NearChoice}
        near=${near}
        onClose=${() => setChoosing(false)}
        onChoose=${(next: Near | null) => {
          onChange(next);
          setChoosing(false);
        }}
      />`
    }`;
}

function NearChoice({
  near,
  onChoose,
  onClose,
}: {
  near: Near | null;
  onChoose: (near: Near | null) => void;
  onClose: () => void;
}) {
  const [centre, setCentre] = useState<Place | undefined>(
    near ? { name: near.label, lat: near.lat, lon: near.lon } : undefined,
  );
  const [km, setKm] = useState<number>(near?.km ?? 5);
  return html`<${Modal} title="Where to look" onClose=${onClose} width=${480}>
    <div class="stack" style="gap: 16px">
      <label class="stack" style="gap: 6px">
        <span class="label">Near</span>
        <${PlaceField} value=${centre} onChange=${setCentre} placeholder="A town, an area, an address" />
      </label>
      <div class="stack" role="group" aria-label="How far" style="gap: 6px">
        <span class="label">Within</span>
        <div class="row" style="flex-wrap: wrap">
          ${RADII.map(
            (r) =>
              html`<button
                type="button"
                class="chip"
                key=${r}
                aria-pressed=${km === r}
                onClick=${() => setKm(r)}
              >
                ${r} km
              </button>`,
          )}
        </div>
      </div>
      <div class="row">
        <button type="button" onClick=${() => onChoose(null)}>Anywhere</button>
        <span style="flex: 1"></span>
        <button
          type="button"
          data-variant="primary"
          disabled=${!hasPoint(centre)}
          onClick=${() =>
            hasPoint(centre) &&
            onChoose({ lat: centre.lat, lon: centre.lon, label: centre.name ?? 'here', km })}
        >
          Show what's near
        </button>
      </div>
    </div>
  </${Modal}>`;
}
