import type { ComponentProps, ReactNode } from 'react';
import styles from './Lane.module.css';

/** A board's column: its name and count over its cards; whoever moves cards brings the drop handlers */
export function Lane({
  name,
  count,
  over = false,
  children,
  ...rest
}: ComponentProps<'section'> & { name: ReactNode; count: number; over?: boolean }) {
  return (
    <section {...rest} className={styles.lane} data-over={over || undefined}>
      <header>
        <h3>{name}</h3>
        <small>{count}</small>
      </header>
      {children}
    </section>
  );
}
