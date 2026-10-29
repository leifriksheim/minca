import { useCallback, useRef, useState } from 'react';
import { useDismiss } from '@minca/app-shared/useDismiss';

/** A panel or menu a button opens, closed again by a click outside `root` or Escape */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);
  return { open, setOpen, close, root };
}
