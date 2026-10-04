import type { CSSProperties, ReactNode } from 'react';
import { hash } from '@weave/app-shared/hash';

/** A kind of thing, as a cover shows it: a label, a glyph and a colour */
export interface Kind {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly hue: number;
}

/** The kind with this id, or the catch-all last one */
export const kindOf = (kinds: ReadonlyArray<Kind>, id: string | undefined): Kind =>
  kinds.find((k) => k.id === id) ?? kinds[kinds.length - 1]!;

/**
 * A picture for something that has none: a wash of its kind's colour and its
 * glyph. Records can carry images, but bytes are not stored yet (spec 05
 * §16.6), so every event and listing gets one of these instead. The record's
 * key shifts the hue a little, so two of a kind side by side still differ.
 */
export function Cover({
  kind,
  seed,
  size = 64,
  className,
  style,
  children,
}: {
  kind: Kind;
  seed: string;
  /** How big the glyph is drawn */
  size?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const hue = kind.hue + (hash(seed) % 36) - 18;
  const tilt = (hash(`${seed}:tilt`) % 24) - 12;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background:
          `radial-gradient(circle at 18% 22%, hsl(${hue} 95% 88% / .9), transparent 55%),` +
          `radial-gradient(circle at 85% 90%, hsl(${hue + 40} 80% 60% / .55), transparent 60%),` +
          `linear-gradient(135deg, hsl(${hue} 70% 74%), hsl(${hue + 28} 65% 58%))`,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: '8%',
          bottom: '6%',
          fontSize: size,
          lineHeight: 1,
          transform: `rotate(${tilt}deg)`,
          filter: 'drop-shadow(0 6px 12px rgba(0, 0, 0, .18))',
        }}
      >
        {kind.emoji}
      </span>
      {children}
    </div>
  );
}
