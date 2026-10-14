import type { CSSProperties, ReactNode } from 'react';
import { hash } from '@minca/app-shared/hash';
import { Shape, shapeFor } from '@minca/app-shared/shapes';
import { palette } from '../../styles';
import type { ShapeColour } from '@minca/app-shared/tokens';

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

/** Where each of the shapes' colours sits on the colour wheel */
const WHEEL: ReadonlyArray<readonly [ShapeColour, number]> = [
  ['coral', 10],
  ['peach', 40],
  ['sage', 150],
  ['cobalt', 230],
  ['lilac', 300],
];

/** A kind's colour, as the nearest of the shapes' colours to its hue */
export function kindColour(kind: Kind): ShapeColour {
  const away = (hue: number) => {
    const d = Math.abs((((kind.hue - hue) % 360) + 360) % 360);
    return Math.min(d, 360 - d);
  };
  let best: ShapeColour = 'cobalt';
  let nearest = Infinity;
  for (const [colour, hue] of WHEEL) {
    if (away(hue) < nearest) {
      nearest = away(hue);
      best = colour;
    }
  }
  return best;
}

/**
 * A picture for something that has none: a flat shape in its kind's colour,
 * on paper. Records can carry images, but bytes are not stored yet (spec 05
 * §16.6), so every event and listing gets one of these instead. The record's
 * key picks the shape and turns it a little, so two of a kind side by side
 * still differ.
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
  /** How big the shape is: twice this many pixels across */
  size?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const tilt = (hash(`${seed}:tilt`) % 24) - 12;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: palette.surface.sunken,
        ...style,
      }}
    >
      <Shape
        kind={shapeFor(seed).kind}
        colour={kindColour(kind)}
        size={size * 2}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: `translate(-50%, -50%) rotate(${tilt}deg)`,
        }}
      />
      {children}
    </div>
  );
}
