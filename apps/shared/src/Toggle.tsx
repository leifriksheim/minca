import { palette } from './styles';

const { surface, accent } = palette;

/** On or off, as a switch: a pill whose knob sits right, on the action colour, when it is on */
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
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        position: 'relative',
        flexShrink: 0,
        width: 40,
        height: 24,
        padding: 0,
        border: `1px solid ${on ? accent.base : surface.lineStrong}`,
        borderRadius: palette.radius.pill,
        background: on ? accent.base : surface.sunken,
        transition: 'background-color .15s ease, border-color .15s ease',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: palette.radius.pill,
          background: surface.card,
          boxShadow: `0 0 0 1px ${on ? accent.base : surface.lineStrong}`,
          transition: 'left .15s ease',
        }}
      />
    </button>
  );
}
