import { useEffect, type RefObject } from 'react';

/**
 * Closes something that floats over the page on a click or tap outside it,
 * one on an app's screen included, or on Escape. A panel that stays open after you have clicked past it feels stuck.
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
    // A tap on an app's screen, a frame of its own, never reaches this page, and a phone doesn't move
    // the focus into it either: while open, frames let taps through to the page, which closes it.
    const frames = [...globalThis.document.querySelectorAll('iframe')].map((frame) => {
      const was = frame.style.pointerEvents;
      frame.style.pointerEvents = 'none';
      return () => {
        frame.style.pointerEvents = was;
      };
    });

    globalThis.document.addEventListener('pointerdown', dismiss);
    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('pointerdown', dismiss);
      globalThis.document.removeEventListener('keydown', onKey);
      for (const restore of frames) restore();
    };
  }, [open, root, close]);
}
