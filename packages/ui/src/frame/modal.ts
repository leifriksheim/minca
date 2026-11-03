import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { html } from './html';

/**
 * A dialog over the screen: a title, a close button, and whatever is in it.
 * The browser's own <dialog>, so focus, Escape and what lies behind are its
 * business. Escape or a click beside it closes it.
 */
export function Modal({
  title,
  onClose,
  width,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  children?: ComponentChildren;
}) {
  const box = useRef<HTMLDialogElement>(null);
  // Open before what is inside it runs its effects, so a field it focuses keeps the focus.
  useLayoutEffect(() => {
    const dialog = box.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // A click on the dialog itself, outside its box, landed on what is behind it.
  const beside = (event: MouseEvent) => {
    const at = box.current?.getBoundingClientRect();
    if (!at || event.target !== box.current) return;
    const { clientX: x, clientY: y } = event;
    if (x < at.left || x > at.right || y < at.top || y > at.bottom) onClose();
  };
  return html`<dialog
    ref=${box}
    aria-label=${title}
    style=${width ? { width: `min(${width}px, 100% - 32px)` } : undefined}
    onClick=${beside}
    onCancel=${(event: Event) => {
      event.preventDefault();
      onClose();
    }}
  >
    <header>
      <h2>${title}</h2>
      <button type="button" data-intent="ghost" data-icon aria-label="Close" onClick=${onClose}>✕</button>
    </header>
    ${children}
  </dialog>`;
}
