import type { ReactNode } from 'react';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Shape } from './shapes';
import { Icon } from './Icon';
import styles from './Choices.module.css';

/** How big a choice's mark is: a shape, or a face, the size a contact's is in a list */
export const MARK_SIZE = 40;

/** One thing to pick: its mark, its name and a line on what it means */
export interface Choice<T extends string> {
  readonly value: T;
  /** Its shape, coloured in turn unless `colour` says */
  readonly shape?: ShapeKind;
  readonly colour?: ShapeColour;
  /** Or a face in its place: an account's avatar, drawn at {@link MARK_SIZE} */
  readonly face?: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** A word beside the title: "Recommended" */
  readonly tag?: string;
}

/** The shape colours, taking turns in their order */
const TURNS: ReadonlyArray<ShapeColour> = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/**
 * Things to pick from, one to a row of a ruled list, each marked by a shape or
 * a face, as a contact is. With `picked`, one of them is chosen, the way a
 * radio button is; without, each row goes on somewhere, and says so with a
 * chevron. Every list of ways on in Minca is this one: making an account or
 * finding one, choosing an account, starting a group and how it is run.
 */
export function Choices<T extends string>({
  label,
  options,
  picked,
  onPick,
  disabled = false,
}: {
  label: string;
  options: ReadonlyArray<Choice<T>>;
  picked?: T | undefined;
  onPick: (value: T) => unknown;
  disabled?: boolean;
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
                onClick={() => void onPick(option.value)}
                disabled={disabled}
                className={`row ${styles.choice}`}
              >
                {option.shape ? (
                  <Shape
                    kind={option.shape}
                    colour={option.colour ?? TURNS[at % TURNS.length] ?? 'cobalt'}
                    size={MARK_SIZE}
                  />
                ) : (
                  <span className={styles.mark}>{option.face}</span>
                )}
                <span className="stack" data-gap="tight">
                  <strong className="row" data-gap="tight">
                    {option.title}
                    {option.tag && <span className="tag">{option.tag}</span>}
                  </strong>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                <span aria-hidden className={choosing ? styles.radio : styles.chevron}>
                  {choosing ? on && <Icon name="check" size={12} /> : <Icon name="chevron" size={16} />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
