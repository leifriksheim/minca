import { palette, styles } from '../styles';

/**
 * The ruled card of rows the app lists things in: a space's apps, its settings, direct messages. Each
 * row is a button with something on the left, a title and a line under it, and a chevron.
 */

/** A row's button, filling its place in the card (`<ol className="rows">`) */
export const rowButton = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minHeight: 64,
  padding: '12px 16px',
  border: 'none',
  borderRadius: 'inherit',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
} as const;
export const cardTitle = { fontSize: 15, fontWeight: 600, color: palette.ink.strong };
export const cardText = { fontSize: 13, lineHeight: 1.45, color: palette.ink.muted };
/** The title over a card of rows: smaller on a phone */
export const sectionHeading = { ...styles.appTitle, fontSize: 'clamp(16px, 4vw, 20px)' };
