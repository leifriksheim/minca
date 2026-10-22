import { ROUND, ROUND_KINDS, radial, type RoundKind } from './round';
import type { ShapeColour } from './tokens';

/**
 * Minca's shapes, as paths on a 100 × 100 canvas, and which shape each thing
 * gets. A space is a grid, and every tool in it is a shape: flat, round, a
 * little odd, and different from its neighbours. They are drawn from formulas
 * rather than shipped as files. Data only, so anything can draw them: React
 * with `Shape` (`@minca/app-shared/shapes`), a screen with the kit.
 */

/** A band whose two sides wave, top to bottom */
function wave(): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const y = 4 + (i / 60) * 92;
    const dx = 9 * Math.sin((i / 60) * Math.PI * 3);
    left.push(`${(30 + dx).toFixed(2)} ${y.toFixed(2)}`);
    right.unshift(`${(70 + dx).toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${left.join('L')}L${right.join('L')}Z`;
}

/*
 * The pieces the shapes that mean something are built from: bands along an
 * arc and pills, both with round ends, circles and rounded rectangles. Every
 * piece winds clockwise, so overlapping pieces join into one; a hole winds
 * the other way.
 */
const n = (v: number) => v.toFixed(2);
const toward = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};
/** A band along an arc, its middle at radius `r`, from `from` to `to` degrees, clockwise from three o'clock */
function arcBand(cx: number, cy: number, r: number, width: number, from: number, to: number): string {
  const ro = r + width / 2;
  const ri = r - width / 2;
  const cap = width / 2;
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const [ox0, oy0] = toward(cx, cy, ro, from);
  const [ox1, oy1] = toward(cx, cy, ro, to);
  const [ix1, iy1] = toward(cx, cy, ri, to);
  const [ix0, iy0] = toward(cx, cy, ri, from);
  return (
    `M${n(ox0)} ${n(oy0)}A${ro} ${ro} 0 ${large} 1 ${n(ox1)} ${n(oy1)}` +
    `A${cap} ${cap} 0 0 1 ${n(ix1)} ${n(iy1)}A${ri} ${ri} 0 ${large} 0 ${n(ix0)} ${n(iy0)}` +
    `A${cap} ${cap} 0 0 1 ${n(ox0)} ${n(oy0)}Z`
  );
}
/** A pill from one point to another */
function pill(x1: number, y1: number, x2: number, y2: number, width: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / len) * (width / 2);
  const ny = ((x2 - x1) / len) * (width / 2);
  const c = width / 2;
  return (
    `M${n(x1 - nx)} ${n(y1 - ny)}L${n(x2 - nx)} ${n(y2 - ny)}A${c} ${c} 0 0 1 ${n(x2 + nx)} ${n(y2 + ny)}` +
    `L${n(x1 + nx)} ${n(y1 + ny)}A${c} ${c} 0 0 1 ${n(x1 - nx)} ${n(y1 - ny)}Z`
  );
}
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
/** A circle that winds clockwise, so it joins the pills it overlaps */
const disc = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0Z`;
const roundRect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
  `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

/** Nobody watching: a closed eye, its lid and three lashes */
function eyeShut(): string {
  const lashes = [55, 90, 125].map((deg) => {
    const [x1, y1] = toward(50, 28, 46, deg);
    const [x2, y2] = toward(50, 28, 60, deg);
    return pill(x1, y1, x2, y2, 9);
  });
  return arcBand(50, 28, 40, 12, 20, 160) + lashes.join('');
}

export const PATHS = {
  scallop: radial(ROUND.scallop),
  flower: radial(ROUND.flower),
  daisy: radial(ROUND.daisy),
  clover: radial(ROUND.clover),
  burst: radial(ROUND.burst),
  star: radial(ROUND.star),
  sparkle: radial(ROUND.sparkle),
  squircle: radial(ROUND.squircle),
  /** Half a circle, lying flat */
  half: 'M2 76A48 48 0 0 1 98 76Z',
  /** Two opposite corners rounded */
  leaf: 'M50 2H98V50A48 48 0 0 1 50 98H2V50A48 48 0 0 1 50 2Z',
  /** Half a ring */
  arch: 'M4 82A46 46 0 0 1 96 82H72A22 22 0 0 0 28 82Z',
  /** A band with wavy sides */
  wave: wave(),
  /** Five squares in an X */
  checker: 'M4 4h30v30H4zM66 4h30v30H66zM35 35h30v30H35zM4 66h30v30H4zM66 66h30v30H66z',
  /** Three dots in a row */
  dots: 'M4 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0M35 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0M66 50a15 15 0 1 0 30 0a15 15 0 1 0-30 0',
  /** Nobody watching: a closed eye */
  eyeShut: eyeShut(),
  /** People deciding together: three heads over the dome of a group */
  group: circle(24, 40, 11) + circle(50, 30, 12) + circle(76, 40, 11) + 'M10 88A40 40 0 0 1 90 88Z',
  /** Kept private: a padlock, its keyhole cut out */
  lock:
    arcBand(50, 44, 21, 11, 180, 360) +
    roundRect(16, 42, 68, 50, 14) +
    'M54 68A8 8 0 1 0 46 68V76A4 4 0 0 0 54 76Z',
  /** Carrying on without a connection: a dot, and arcs of signal with the outer one broken */
  signal:
    circle(50, 76, 8) +
    arcBand(50, 78, 26, 11, 225, 315) +
    arcBand(50, 78, 46, 11, 215, 245) +
    arcBand(50, 78, 46, 11, 295, 325),
  /** An account you keep: a key, its ring, shaft and two teeth */
  key:
    arcBand(28, 50, 16, 14, 0, 180) +
    arcBand(28, 50, 16, 14, 180, 360) +
    pill(42, 50, 92, 50, 14) +
    pill(72, 50, 72, 68, 12) +
    pill(86, 50, 86, 63, 12),
  /** A space: four squares of the grid */
  grid: [6, 54].flatMap((y) => [6, 54].map((x) => roundRect(x, y, 40, 40, 12))).join(''),
  /** Signed versions, one on another */
  stack: roundRect(24, 8, 52, 22, 11) + roundRect(14, 39, 72, 22, 11) + roundRect(4, 70, 92, 22, 11),
  /** Who may do what: a shield */
  shield: 'M50 4C64 13 78 16 90 16V46C90 71 73 88 50 96C27 88 10 71 10 46V16C22 16 36 13 50 4Z',
  /** Checked the same way everywhere: a tick */
  tick: pill(16, 54, 40, 78, 18) + pill(40, 78, 84, 26, 18),
  /** What an app gets instead of your keys: a pass, notched at its sides */
  pass: 'M14 20H86A10 10 0 0 1 96 30V38A12 12 0 0 0 96 62V70A10 10 0 0 1 86 80H14A10 10 0 0 1 4 70V62A12 12 0 0 0 4 38V30A10 10 0 0 1 14 20Z',
  /** The same engine anywhere: three nodes, each joined to the others */
  mesh:
    pill(50, 20, 20, 76, 10) +
    pill(20, 76, 80, 76, 10) +
    pill(80, 76, 50, 20, 10) +
    disc(50, 20, 15) +
    disc(20, 76, 15) +
    disc(80, 76, 15),
  /** A team at work: a briefcase and its handle */
  briefcase: arcBand(50, 30, 14, 10, 180, 360) + roundRect(6, 30, 88, 60, 14),
  /** A club that plays: a pawn, its head, collar and base */
  pawn: disc(50, 24, 16) + pill(32, 46, 68, 46, 12) + 'M40 46H60L66 78H34Z' + roundRect(20, 76, 60, 18, 9),
  /** Money of a group's own: a coin, a groove round its face */
  coin: disc(50, 50, 46) + circle(50, 50, 35) + disc(50, 50, 28),
} as const;

export type { RoundKind };

export type ShapeKind = keyof typeof PATHS;

/** Each built-in app's shape and colour, the same on the site as in the app */
export const APP_SHAPES: Readonly<Record<string, { kind: ShapeKind; colour: ShapeColour }>> = {
  chat: { kind: 'scallop', colour: 'cobalt' },
  polls: { kind: 'wave', colour: 'coral' },
  decisions: { kind: 'burst', colour: 'peach' },
  events: { kind: 'flower', colour: 'sage' },
  kanban: { kind: 'checker', colour: 'lilac' },
  marketplace: { kind: 'leaf', colour: 'cobalt' },
  calls: { kind: 'arch', colour: 'coral' },
};

const CYCLE: readonly ShapeColour[] = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];

/**
 * The shape for anything with an id: a built-in app's own, or, for an app a
 * group made or a space, one of the round shapes picked by the id, so the same
 * thing always gets the same shape.
 */
export function shapeFor(id: string): { kind: ShapeKind; colour: ShapeColour } {
  return APP_SHAPES[id] ?? pick(id, ROUND_KINDS);
}

/** Round shapes solid at the middle, where a letter can sit */
const SOLID_KINDS: readonly RoundKind[] = ['scallop', 'flower', 'clover', 'burst', 'squircle'];

/** The shape for something marked with a letter on top, like a space: picked by its id from the solid ones */
export function markFor(id: string): { kind: RoundKind; colour: ShapeColour } {
  return pick(id, SOLID_KINDS);
}

function pick(id: string, kinds: readonly RoundKind[]): { kind: RoundKind; colour: ShapeColour } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const n = Math.abs(hash);
  return {
    kind: kinds[n % kinds.length] ?? 'scallop',
    colour: CYCLE[Math.floor(n / kinds.length) % CYCLE.length] ?? 'cobalt',
  };
}
