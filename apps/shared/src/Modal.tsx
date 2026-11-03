import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import styles from './Modal.module.css';

/**
 * A dialog over the page: the browser's own `<dialog>`, as the kit's Modal
 * is, so focus, Escape and what lies behind are its business.
 *
 * Used where a choice has enough parts that inlining it would crowd the thing
 * it is about — creating a list needs a name and two decisions, which is more
 * than belongs permanently under a list of lists.
 *
 * Closes on Escape, on a click beside it and on the ✕ at its top right.
 */
export function Modal({
  title,
  onClose,
  children,
  width,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider than the default, for a dialog with more to it */
  width?: number;
}) {
  const box = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = box.current;
    dialog?.showModal();
    // The first field or button, never the ✕, which would make Enter close it.
    const first = [...(dialog?.querySelectorAll<HTMLElement>('input, select, textarea, button') ?? [])].find(
      (one) => one !== close.current,
    );
    first?.focus();
    return () => dialog?.close();
  }, []);
  // A click on the dialog itself, outside its box, landed on the backdrop.
  const beside = (event: MouseEvent<HTMLDialogElement>) => {
    const at = box.current?.getBoundingClientRect();
    if (!at || event.target !== box.current) return;
    const { clientX: x, clientY: y } = event;
    if (x < at.left || x > at.right || y < at.top || y > at.bottom) onClose();
  };
  return (
    <dialog
      ref={box}
      aria-label={title}
      className={styles.modal}
      style={width ? { maxWidth: width } : undefined}
      onClick={beside}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button ref={close} type="button" data-intent="quiet" data-icon aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}

/** One question with two answers, which is every choice a list has. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div role="tablist" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            onClick={() => onChange(option.value)}
            aria-selected={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
