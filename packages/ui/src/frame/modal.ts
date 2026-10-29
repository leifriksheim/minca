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
  // The latest onClose, since screens pass a new one each time they draw
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (event: KeyboardEvent) => event.key === 'Escape' && close.current();
    addEventListener('keydown', away);
    // Once, when it opens: taken again on every redraw, it would pull the cursor out of what is being typed.
    box.current?.focus();
    return () => removeEventListener('keydown', away);
  }, []);
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
