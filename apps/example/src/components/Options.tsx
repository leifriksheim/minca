import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Shape } from '@minca/app-shared/shapes';
import { Icon } from '@minca/app-shared/Icon';
import styles from './Options.module.css';

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
    // The list's look, and a radio group's meaning around it when one is chosen.
    <div role={choosing ? 'radiogroup' : 'group'} aria-label={label}>
      <ul role="list">
        {options.map((option, at) => {
          const on = option.value === picked;
          return (
            <li key={option.value}>
              <button
                type="button"
                data-intent="open"
                role={choosing ? 'radio' : undefined}
                aria-checked={choosing ? on : undefined}
                onClick={() => onPick(option.value)}
                className={`row ${styles.option}`}
              >
                <Shape kind={option.shape} colour={TURNS[at % TURNS.length]} size={36} />
                <span className="stack" data-gap="tight">
                  <strong>{option.title}</strong>
                  <small>{option.detail}</small>
                </span>
                {on && (
                  <span aria-hidden className={styles.tick}>
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
