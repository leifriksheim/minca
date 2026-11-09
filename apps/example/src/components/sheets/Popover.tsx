import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { usePopover } from '../usePopover';
import styles from './Sheets.module.css';

/** A gap kept between a panel and the window's edges */
const EDGE = 8;

/**
 * A small panel under what opened it. It floats over the page, placed from
 * where its anchor is on screen, so a row of tabs or a table that scrolls
 * sideways can't cut it off. It stays inside its anchor in the page's tree,
 * so a click in it is still a click inside, and doesn't close it.
 */
export function Panel({
  anchor,
  align,
  className = '',
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  /** Which edge of its anchor it lines up with */
  align: 'start' | 'end';
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const placeUnderAnchor = () => {
      const at = anchor.current?.getBoundingClientRect();
      const box = panel.current;
      if (!at || !box) return;
      const wanted = align === 'start' ? at.left : at.right - box.offsetWidth;
      const left = Math.max(EDGE, Math.min(wanted, innerWidth - box.offsetWidth - EDGE));
      box.style.setProperty('--panel-top', `${at.bottom + 4}px`);
      box.style.setProperty('--panel-left', `${left}px`);
    };
    placeUnderAnchor();
    addEventListener('resize', placeUnderAnchor);
    // Any scroll, of the page or of the sheet, moves the anchor.
    addEventListener('scroll', placeUnderAnchor, true);
    return () => {
      removeEventListener('resize', placeUnderAnchor);
      removeEventListener('scroll', placeUnderAnchor, true);
    };
  }, [anchor, align]);
  return (
    <div ref={panel} className={`${styles.popover} ${className}`}>
      {children}
    </div>
  );
}

/** A quiet toolbar button that opens a panel under it; `active` when what it sets is in use */
export function Popover({
  icon,
  label,
  active = false,
  align = 'end',
  children,
}: {
  icon: IconName;
  label: ReactNode;
  active?: boolean;
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, close, root } = usePopover();
  return (
    <div ref={root} className={styles.popoverAnchor}>
      <button
        className={styles.tool}
        data-active={active || undefined}
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
      >
        <Icon name={icon} size={14} />
        {label}
      </button>
      {open && (
        <Panel anchor={root} align={align}>
          {children(close)}
        </Panel>
      )}
    </div>
  );
}
