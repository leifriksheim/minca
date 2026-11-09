import type { ReactNode } from 'react';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { usePopover } from '../usePopover';
import styles from './Sheets.module.css';

/** A quiet toolbar button that opens a small panel under it; `active` when what it sets is in use */
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
        <div className={styles.popover} data-align={align}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
