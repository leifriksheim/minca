import { useState, type DragEvent } from 'react';

/**
 * Rows put in order by dragging, as people do everywhere: pick a row up,
 * drop it on the row whose place it takes. Spread `rowProps(index)` on each
 * row; the design system draws the row being moved and where it lands.
 */
export function useDragOrder(onMove: (from: number, to: number) => void, enabled = true) {
  const [moving, setMoving] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => {
    setMoving(null);
    setOver(null);
  };
  return (index: number) =>
    enabled
      ? {
          draggable: true,
          'data-moving': moving === index || undefined,
          'data-landing': (moving !== null && moving !== index && over === index) || undefined,
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
            setMoving(index);
          },
          onDragOver: (event: DragEvent) => {
            if (moving === null) return;
            event.preventDefault();
            setOver(index);
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            if (moving !== null && moving !== index) onMove(moving, index);
            end();
          },
          onDragEnd: end,
        }
      : {};
}

/** A copy of `items` with the one at `from` moved to `to` */
export function moved<T>(items: ReadonlyArray<T>, from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
