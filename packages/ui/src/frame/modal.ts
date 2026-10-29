import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { html } from './html';

/**
 * A dialog over the screen: a title, a close button, and whatever is in it.
 * It doesn't dim the screen behind, which is only one pane of the app around
 * it. Escape or a click beside it closes it.
 */
export function Modal({
  title,
  onClose,
  width = 520,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  children?: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    addEventListener('keydown', away);
    // What was in focus before goes back to the page beneath; the dialog takes it.
    box.current?.focus();
    return () => removeEventListener('keydown', away);
  }, [onClose]);
  return html`<div
    class="modal-scrim"
    onClick=${(event: Event) => event.target === event.currentTarget && onClose()}
  >
    <div
      ref=${box}
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label=${title}
      tabindex="-1"
      style=${{ maxWidth: `${width}px` }}
    >
      <header class="row">
        <h2 style="flex: 1">${title}</h2>
        <button type="button" data-variant="ghost" data-icon aria-label="Close" onClick=${onClose}>✕</button>
      </header>
      ${children}
    </div>
  </div>`;
}
