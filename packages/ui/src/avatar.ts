import { hash } from './hash';
import { ROUND, ROUND_KINDS, radial } from './round';
import { shapeColours, shapeGrounds } from './tokens';

/**
 * An account's avatar as data, from its DID, so every app (and the extension)
 * draws the same one: two of the round shapes melted together at a point the
 * DID picks, turned a little, in a shape colour on a ground. On a 100 × 100
 * canvas, like the shapes.
 *
 * The dark colours sit on a pale ground of another; peach and lilac are too
 * pale for that, so they sit on a dark one instead. Shapes, blends, turns and
 * colours together give over ten thousand avatars, enough that two people in
 * one space rarely look alike.
 */
export type AvatarShape = { d: string; fill: string; ground: string };

/** Each foreground and the grounds it can stand on */
const PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [shapeColours.cobalt, [shapeGrounds.coral, shapeGrounds.peach, shapeGrounds.sage, shapeGrounds.lilac]],
  [shapeColours.coral, [shapeGrounds.cobalt, shapeGrounds.peach, shapeGrounds.sage, shapeGrounds.lilac]],
  [shapeColours.sage, [shapeGrounds.cobalt, shapeGrounds.coral, shapeGrounds.peach, shapeGrounds.lilac]],
  [shapeColours.peach, [shapeColours.cobalt, shapeColours.sage, shapeColours.ink]],
  [shapeColours.lilac, [shapeColours.cobalt, shapeColours.sage, shapeColours.ink]],
];
const BLENDS = [0.3, 0.5, 0.7] as const;
const TURNS = 8;
/** Fewer points than a shape on its own: avatars come many to a screen and small */
const STEPS = 120;

const drawn = new Map<string, AvatarShape>();

/** MurmurHash3's finaliser: every bit of the input moves every bit of the output, low ones included */
function mix(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export function avatarShape(did: string): AvatarShape {
  const known = drawn.get(did);
  if (known) return known;
  let state = hash(did);
  const pick = (n: number) => {
    state = mix(state + 0x9e3779b9);
    return state % n;
  };

  const first = pick(ROUND_KINDS.length);
  const second = (first + 1 + pick(ROUND_KINDS.length - 1)) % ROUND_KINDS.length;
  const a = ROUND[ROUND_KINDS[first] ?? 'scallop'];
  const b = ROUND[ROUND_KINDS[second] ?? 'flower'];
  const t = BLENDS[pick(BLENDS.length)] ?? 0.5;
  // Up to an eighth of a turn, which is as far as the most symmetric of them goes before repeating
  const turn = (pick(TURNS) / TURNS) * (Math.PI / 4);
  const [fill, grounds] = PAIRS[pick(PAIRS.length)] ?? [shapeColours.cobalt, [shapeGrounds.peach]];
  const ground = grounds[pick(grounds.length)] ?? shapeGrounds.peach;

  const d = radial((angle) => {
    const at = angle - turn;
    return 0.92 * (a(at) + (b(at) - a(at)) * t);
  }, STEPS);
  const shape = { d, fill, ground };
  drawn.set(did, shape);
  return shape;
}

/** The corner an avatar of this size takes: a rounded square, or a circle inside something round */
export const avatarRadius = (size: number, round = false): string => (round ? '50%' : `${size / 4}px`);

/** In a circle the shape's tips would be cut off, so it shrinks to sit inside it */
export const avatarFit = (round = false): string | undefined =>
  round ? 'translate(50 50) scale(0.74) translate(-50 -50)' : undefined;

/** The avatar as an SVG element, for pages and elements drawn without React (`<minca-auth>`'s `avatar`) */
export function avatarElement(did: string, size: number, round = false): SVGSVGElement {
  const { d, fill, ground } = avatarShape(did);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = globalThis.document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Account avatar');
  svg.style.cssText = `border-radius:${avatarRadius(size, round)};background:${ground};flex-shrink:0;display:block`;
  const path = globalThis.document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', fill);
  const fit = avatarFit(round);
  if (fit) path.setAttribute('transform', fit);
  svg.appendChild(path);
  return svg;
}
