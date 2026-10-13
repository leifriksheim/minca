import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Filter } from '@minca/core';
import { cellsAround, cellsOf, centreOf, distanceKm, geohash, type CalendarEvent } from '@minca/core/schemas';
import { Modal } from '@minca/app-shared/Modal';
import {
  PLACES_CREDIT,
  PLACES_CREDIT_URL,
  placeAt,
  searchPlaces,
  whereAmI,
  type FoundPlace,
} from '@minca/app-shared/places';
import { styles, palette, ui } from '../../styles';

/** A place as the standard records keep it: a name, an address, a point and its cells */
export type Place = NonNullable<CalendarEvent['place']>;

/** Where someone is looking from, and how far: kept on this device only */
export interface Near {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
  readonly km: number;
}

const RADII = [1, 2, 5, 10, 25, 50, 100, 250] as const;

/** Where the person is looking from, for whatever shows a distance */
export const NearContext = createContext<Near | null>(null);

/** "2.4 km", how far a place is from where the person is looking; empty when either has no point */
export function useDistance(place: Place | undefined): string {
  const km = distanceFrom(useContext(NearContext), place);
  return km === null ? '' : distanceText(km);
}
const NEAR_KEY = 'minca:near';

/**
 * A place found, as a record keeps it. `coarse` keeps only the part of town:
 * the point moves to the middle of its 1 km cell and the street is left out,
 * for a listing, where the exact spot is usually someone's home.
 */
function placeFrom(found: FoundPlace, coarse = false): Place {
  const point = coarse
    ? centreOf(geohash(found.lat, found.lon, 6))
    : { lat: round(found.lat), lon: round(found.lon) };
  const lat = round(point.lat);
  const lon = round(point.lon);
  const name = coarse ? (found.area ?? found.locality ?? found.name) : found.name;
  const address = {
    ...(!coarse && found.street ? { street: found.street } : {}),
    ...(found.locality && found.locality !== name ? { locality: found.locality } : {}),
    ...(!coarse && found.postcode ? { postcode: found.postcode } : {}),
    ...(found.country ? { country: found.country } : {}),
  };
  return {
    name,
    ...(Object.keys(address).length ? { address } : {}),
    lat,
    lon,
    cells: cellsOf(lat, lon),
  };
}

/** A metre is plenty, and keeps a record from saying more than it means */
const round = (degrees: number) => Math.round(degrees * 1e5) / 1e5;

/** Where, in one line: the place's name, then its street and town */
export function placeLabel(place: Place | undefined): string {
  if (!place) return '';
  const { name, address } = place;
  return [name, address?.street, address?.locality]
    .filter((part, i, all) => part && all.indexOf(part) === i)
    .join(', ');
}

const hasPoint = (place: Place | undefined): place is Place & { lat: number; lon: number } =>
  typeof place?.lat === 'number' && typeof place.lon === 'number';

/** How far a place is from where someone is looking, in km; null when it has no point */
export const distanceFrom = (near: Near | null, place: Place | undefined): number | null =>
  near && hasPoint(place) ? distanceKm(near, place) : null;

/** "800 m", "2.4 km", "35 km" */
function distanceText(km: number): string {
  const metres = Math.max(50, Math.round((km * 1000) / 50) * 50);
  if (metres < 1000) return `${metres} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * The part of a query that keeps places in reach: their cells, matched the
 * way a keeper matches a topic. Undefined when the circle is too big for
 * cells to help; then distance alone decides.
 */
export function nearWhere(near: Near | null): Filter | undefined {
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

/** Where this person last said they're looking from, shared by every app here */
export function useNear(): [Near | null, (near: Near | null) => void] {
  const [near, setNear] = useState<Near | null>(readNear);
  return [
    near,
    (next) => {
      setNear(next);
      try {
        if (next) globalThis.localStorage.setItem(NEAR_KEY, JSON.stringify(next));
        else globalThis.localStorage.removeItem(NEAR_KEY);
      } catch {
        // Private windows can refuse; it lasts until the page closes.
      }
    },
  ];
}

function readNear(): Near | null {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage.getItem(NEAR_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { lat, lon, label, km } = Object.fromEntries(Object.entries(value));
    return typeof lat === 'number' &&
      typeof lon === 'number' &&
      typeof label === 'string' &&
      typeof km === 'number'
      ? { lat, lon, label, km }
      : null;
  } catch {
    return null;
  }
}

/**
 * Typing a place and picking one of what OpenStreetMap knows, or using where
 * the device is. Until a suggestion is picked, what is typed is kept as a
 * name with no point, which shows but can't be found by distance.
 */
export function PlaceField({
  value,
  onChange,
  coarse,
  near,
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
    const stop = new AbortController();
    const timer = setTimeout(() => {
      setState('busy');
      searchPlaces(text, { ...(near ? { near } : {}), signal: stop.signal })
        .then((found) => {
          setResults(found);
          setActive(0);
          setState('idle');
        })
        .catch(() => {
          if (!stop.signal.aborted) setState('failed');
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      stop.abort();
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
    const at = await whereAmI();
    if (!at) return setState('located');
    try {
      const found = await placeAt(at.lat, at.lon);
      pick(
        found
          ? { ...found, lat: at.lat, lon: at.lon }
          : { name: 'My location', detail: '', lat: at.lat, lon: at.lon, kind: 'point' },
      );
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  if (hasPoint(value)) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minHeight: 40,
          padding: '6px 6px 6px 12px',
          border: `1px solid ${palette.surface.lineStrong}`,
          borderRadius: palette.radius.md,
        }}
      >
        <span aria-hidden>📍</span>
        <span style={{ ...ui.stack, flex: 1, minWidth: 0 }}>
          <strong style={{ ...ui.ellipsis, fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>
            {value.name ?? 'A point on the map'}
          </strong>
          <span style={{ ...ui.ellipsis, fontSize: 12, color: palette.ink.faint }}>
            {[value.address?.street, value.address?.locality].filter(Boolean).join(', ') ||
              `${value.lat.toFixed(4)}, ${value.lon.toFixed(4)}`}
            {coarse ? ' · shown as the area, not the exact spot' : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(undefined);
            setTimeout(() => input.current?.focus());
          }}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Change
        </button>
      </div>
    );
  }

  const shown = open && text.trim().length >= 3 ? results : [];
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            onChange(e.target.value.trim() ? { name: e.target.value.trim() } : undefined);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && shown.length) {
              e.preventDefault();
              setActive((active + 1) % shown.length);
            } else if (e.key === 'ArrowUp' && shown.length) {
              e.preventDefault();
              setActive((active - 1 + shown.length) % shown.length);
            } else if (e.key === 'Enter' && shown[active]) {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-autocomplete="list"
          aria-controls="place-results"
          style={{ ...styles.input, flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          onClick={() => void here()}
          data-variant="quiet"
          title="Use where I am"
          aria-label="Use where I am"
          style={{ ...styles.smallButton, height: 40, width: 40, padding: 0, fontSize: 16 }}
        >
          ◎
        </button>
      </div>
      {state === 'failed' && (
        <p style={hint}>The place search can't be reached. What you type is kept as it is.</p>
      )}
      {state === 'located' && <p style={hint}>This browser didn't share where you are.</p>}
      {text.trim() && !shown.length && state === 'idle' && (
        <p style={hint}>Pick a suggestion to put it on the map, so people nearby can find it.</p>
      )}
      {shown.length > 0 && (
        <ul id="place-results" role="listbox" style={list}>
          {shown.map((found, i) => (
            <li
              key={`${found.lat},${found.lon},${found.name}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(found);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                padding: '8px 12px',
                cursor: 'pointer',
                background: i === active ? palette.surface.sunken : undefined,
              }}
            >
              <span style={{ ...ui.ellipsis, fontSize: 14, color: palette.ink.strong }}>{found.name}</span>
              {found.detail && (
                <span style={{ ...ui.ellipsis, fontSize: 12, color: palette.ink.faint }}>{found.detail}</span>
              )}
            </li>
          ))}
          <li
            style={{
              padding: '6px 12px',
              fontSize: 11,
              color: palette.ink.faint,
              borderTop: `1px solid ${palette.surface.line}`,
            }}
          >
            <a href={PLACES_CREDIT_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              {PLACES_CREDIT}
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

/** "Anywhere", or "Within 5 km of Grünerløkka": opens the choice of where and how far */
export function NearButton({ near, onChange }: { near: Near | null; onChange: (near: Near | null) => void }) {
  const [choosing, setChoosing] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setChoosing(true)}
        aria-pressed={!!near}
        style={{ ...ui.chip, height: 32, maxWidth: 280, ...(near ? ui.chipOn : {}) }}
      >
        <span aria-hidden>📍</span>
        <span style={ui.ellipsis}>{near ? `Within ${near.km} km of ${near.label}` : 'Anywhere'}</span>
      </button>
      {choosing && (
        <NearChoice
          near={near}
          onClose={() => setChoosing(false)}
          onChoose={(next) => {
            onChange(next);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
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
  return (
    <Modal title="Where to look" onClose={onClose} width={480}>
      <div style={{ ...ui.stack, gap: 16 }}>
        <div style={{ ...ui.stack, gap: 6 }}>
          <span style={{ ...styles.fieldLabel, margin: 0 }}>Near</span>
          <PlaceField value={centre} onChange={setCentre} placeholder="A town, an area, an address" />
        </div>
        <div role="group" aria-label="How far" style={{ ...ui.stack, gap: 6 }}>
          <span style={{ ...styles.fieldLabel, margin: 0 }}>Within</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {RADII.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={km === r}
                onClick={() => setKm(r)}
                style={{ ...ui.chip, height: 30, ...(km === r ? ui.chipOn : {}) }}
              >
                {r} km
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => onChoose(null)}
            data-variant="quiet"
            style={styles.smallButton}
          >
            Anywhere
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            disabled={!hasPoint(centre)}
            onClick={() =>
              hasPoint(centre) &&
              onChoose({ lat: centre.lat, lon: centre.lon, label: centre.name ?? 'here', km })
            }
            data-variant="primary"
            style={{ ...styles.addButton, height: 32 }}
          >
            Show what's near
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A small map of a place, from OpenStreetMap's own embed */
export function PlaceMap({ place, height = 200 }: { place: Place | undefined; height?: number }) {
  if (!hasPoint(place)) return null;
  const d = 0.006;
  const bbox = [place.lon - d * 2, place.lat - d, place.lon + d * 2, place.lat + d]
    .map((n) => n.toFixed(5))
    .join(',');
  return (
    <figure style={{ ...ui.stack, gap: 4 }}>
      <iframe
        title={`Map of ${placeLabel(place)}`}
        src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${place.lat},${place.lon}`}
        loading="lazy"
        style={{
          width: '100%',
          height,
          border: `1px solid ${palette.surface.line}`,
          borderRadius: palette.radius.lg,
        }}
      />
      <figcaption style={{ fontSize: 11, color: palette.ink.faint }}>
        <a
          href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=16/${place.lat}/${place.lon}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: 'inherit' }}
        >
          Open the map
        </a>{' '}
        ·{' '}
        <a href={PLACES_CREDIT_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
          {PLACES_CREDIT}
        </a>
      </figcaption>
    </figure>
  );
}

const hint: CSSProperties = { fontSize: 12, color: palette.ink.faint, marginTop: 6 };
const list: CSSProperties = {
  position: 'absolute',
  zIndex: 5,
  top: 44,
  left: 0,
  right: 0,
  margin: 0,
  padding: '4px 0 0',
  listStyle: 'none',
  background: palette.surface.card,
  border: `1px solid ${palette.surface.rule}`,
  borderRadius: palette.radius.lg,
  boxShadow: palette.shadow.float,
  overflow: 'hidden',
};
