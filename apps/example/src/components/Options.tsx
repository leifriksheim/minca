import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Shape } from '@minca/app-shared/shapes';
import { palette, ui } from '../styles';
import { Icon } from './Icon';

const { ink, surface, accent } = palette;

/** One thing to pick: its shape, its name and a line on what it means */
export interface Option<T extends string> {
  readonly value: T;
  readonly shape: ShapeKind;
  readonly title: string;
  readonly detail: string;
}

/** The shape colours, taking turns in their order */
const TURNS: ReadonlyArray<ShapeColour> = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/**
 * Things to pick from, one to a row of a ruled card, each marked by its shape, as points in a list
 * are. With `picked`, one of them is chosen, the way a radio button is; without, each row is an action.
 */
export function Options<T extends string>({
  label,
  options,
  picked,
  onPick,
}: {
  label: string;
  options: ReadonlyArray<Option<T>>;
  picked?: T;
  onPick: (value: T) => void;
}) {
  const choosing = picked !== undefined;
  return (
    <ul
      className="rows"
      role={choosing ? 'radiogroup' : undefined}
      aria-label={label}
      style={{ ...ui.list, listStyle: 'none' }}
    >
      {options.map((option, at) => {
        const on = option.value === picked;
        return (
          <li key={option.value} data-tile style={{ listStyle: 'none', ...(on ? chosen : {}) }}>
            <button
              type="button"
              role={choosing ? 'radio' : undefined}
              aria-checked={choosing ? on : undefined}
              onClick={() => onPick(option.value)}
              style={row}
            >
              <Shape kind={option.shape} colour={TURNS[at % TURNS.length]} size={36} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 15, fontWeight: 600, color: ink.strong }}>{option.title}</strong>
                <span style={{ fontSize: 13, lineHeight: 1.45, color: ink.muted }}>{option.detail}</span>
              </span>
              {on && (
                <span aria-hidden style={tick}>
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const row = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  position: 'relative',
  padding: '14px 36px 14px 16px',
  border: 'none',
  borderRadius: 'inherit',
  background: 'none',
  textAlign: 'left',
} as const;

/** The chosen one: set on the soft action colour, with no edge of its own */
const chosen = { background: accent.soft } as const;

/** And a small tick in its top right corner */
const tick = {
  position: 'absolute',
  top: 10,
  right: 10,
  width: 20,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.pill,
  background: accent.base,
  color: surface.card,
} as const;
