import type { ButtonHTMLAttributes } from 'react';
import { styles } from '../styles';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** The small quiet button of rows and toolbars; `style` adds to its look */
export function QuietButton({ style, ...props }: ButtonProps) {
  return <button data-variant="quiet" {...props} style={{ ...styles.smallButton, ...style }} />;
}

/** A button that reads as a link, for the lesser actions beside a main one */
export function LinkButton({ style, ...props }: ButtonProps) {
  return <button data-variant="ghost" {...props} style={{ ...styles.linkButton, ...style }} />;
}

/** The main action of a form or a dialog */
export function PrimaryButton({ style, ...props }: ButtonProps) {
  return <button data-variant="primary" {...props} style={{ ...styles.button, ...style }} />;
}

/** The main action beside something, as wide as its words */
export function AddButton({ style, ...props }: ButtonProps) {
  return <button data-variant="primary" {...props} style={{ ...styles.addButton, ...style }} />;
}
