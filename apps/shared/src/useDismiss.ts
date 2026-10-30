import { useEffect, type RefObject } from 'react';

/**
 * Closes something that floats over the page on a click or tap outside it,
 * one in a tool's frame included, or on Escape. A panel that stays open after you have clicked past it feels stuck.
 */
export function useDismiss(open: boolean, root: RefObject<Element | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;

    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // A click in a tool's screen, which is a frame of its own, never reaches this page; it only takes
    // the focus away into the frame.
    const intoFrame = () => {
      if (globalThis.document.activeElement instanceof HTMLIFrameElement) close();
    };

    globalThis.document.addEventListener('pointerdown', dismiss);
    globalThis.document.addEventListener('keydown', onKey);
    globalThis.addEventListener('blur', intoFrame);
    return () => {
      globalThis.document.removeEventListener('pointerdown', dismiss);
      globalThis.document.removeEventListener('keydown', onKey);
      globalThis.removeEventListener('blur', intoFrame);
    };
  }, [open, root, close]);
}
