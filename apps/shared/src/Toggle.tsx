/** On or off, as a switch: the system's `<input type="checkbox" role="switch">` */
export function Toggle({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  /** What it turns on, for those who can't see the row it sits in */
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      checked={on}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
