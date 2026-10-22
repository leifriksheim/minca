import type { ComponentChildren } from 'preact';
import { hash } from '../hash';
import { PATHS, shapeFor, type ShapeKind } from '../shapes';
import { shapeColours, type ShapeColour } from '../tokens';
import { html } from './html';

/** One of Minca's shapes, in one of their colours */
export function Shape({
  kind,
  colour = 'cobalt',
  size = 40,
  style,
}: {
  kind: ShapeKind;
  colour?: ShapeColour;
  size?: number;
  style?: string | Record<string, string | number>;
}) {
  return html`<svg viewBox="0 0 100 100" width=${size} height=${size} aria-hidden="true" style=${style}>
    <path d=${PATHS[kind]} fill=${shapeColours[colour]} />
  </svg>`;
}

/**
 * A picture for something that has none: a big flat shape in a colour, on a
 * sunken ground, picked and turned a little by `seed` (a record's key), so
 * two side by side differ. Whatever is inside sits on top.
 */
export function Cover({
  seed,
  colour,
  size = 64,
  class: className,
  children,
}: {
  seed: string;
  colour: ShapeColour;
  /** How big the shape is: twice this many pixels across */
  size?: number;
  class?: string;
  children?: ComponentChildren;
}) {
  const tilt = (hash(`${seed}:tilt`) % 24) - 12;
  return html`<div class=${className ? `cover ${className}` : 'cover'}>
    <${Shape}
      kind=${shapeFor(seed).kind}
      colour=${colour}
      size=${size * 2}
      style=${`position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(${tilt}deg)`}
    />
    ${children}
  </div>`;
}
