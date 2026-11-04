import type { ReactNode } from 'react';
import css from './TopBar.module.css';

/** The bar along the top of the site and the account home: one outlined pill. What sits in it lays itself out. */
export function TopBar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className ? `${css.bar} ${className}` : css.bar}>{children}</div>;
}
