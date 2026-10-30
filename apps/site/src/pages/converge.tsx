import { shapeColours } from '@minca/ui/tokens';
import { LOGOS } from './converge-logos';

/**
 * The apps a group juggles, a stream of logos drifting in from the edge along
 * a few lanes, crushed in one prism that sends out Minca's four colours, after
 * the cover of The Dark Side of the Moon.
 */

type Logo = (typeof LOGOS)[number];

/**
 * The lanes the stream runs in: each comes in level at height y and bends at
 * x towards the prism. Each runs at its own pace and starts at its own phase,
 * so the logos come in loose rather than in step.
 */
const LANES: ReadonlyArray<{ x: number; y: number; pace: number; phase: number }> = [
  { x: 180, y: 30, pace: 1.1, phase: 0.1 },
  { x: 60, y: 107, pace: 0.9, phase: 0.55 },
  { x: 240, y: 183, pace: 1.2, phase: 0.3 },
  { x: 120, y: 250, pace: 1, phase: 0.8 },
  { x: 260, y: 337, pace: 0.85, phase: 0.05 },
  { x: 40, y: 413, pace: 1.15, phase: 0.65 },
  { x: 200, y: 490, pace: 0.95, phase: 0.4 },
];

/** The prism, and where the light comes in and the colours go out */
const PRISM = { top: [640, 150], left: [530, 340], right: [750, 340] } as const;
const IN = [585, 245] as const;
const OUT = [
  [691, 238],
  [721, 290],
] as const;

/** Minca's four colours, outside in, fanning from the prism off the right of the screen */
const SPECTRUM = [shapeColours.cobalt, shapeColours.coral, shapeColours.peach, shapeColours.sage];
const EDGE = { x: 2600, top: 220, bottom: 620 };

/** Where the lanes start, off the left of the screen */
const START = -700;
const TILE = 76;
const GLYPH = 40;
/** Seconds a logo takes from the edge into the glass, at a lane's pace of 1 */
const TRIP = 9;

/** A lane runs in from the edge, then bends towards the prism like a stream finding its course */
const lane = ({ x, y }: { x: number; y: number }) =>
  `M${START} ${y}H${x}C${x + 260} ${y} ${IN[0] - 200} ${IN[1] + (y - IN[1]) * 0.2} ${IN[0]} ${IN[1]}`;

type Point = readonly [number, number];

/** The point a fraction t of the way from one point to another */
const at = ([x0, y0]: Point, [x1, y1]: Point, t: number) => `${x0 + (x1 - x0) * t} ${y0 + (y1 - y0) * t}`;

/** How far along each side the prism's corners start to round, soft like the cards */
const ROUND = 24;

/** A shape through the corners, each corner a curve from ROUND along one side to ROUND along the next */
function rounded(corners: readonly Point[]) {
  const toward = (from: Point, to: Point) =>
    at(from, to, ROUND / Math.hypot(to[0] - from[0], to[1] - from[1]));
  const n = corners.length;
  return `${corners
    .map((corner, i) => {
      const before = corners[(i + n - 1) % n] ?? corner;
      const after = corners[(i + 1) % n] ?? corner;
      return `${i ? 'L' : 'M'}${toward(corner, before)}Q${corner.join(' ')} ${toward(corner, after)}`;
    })
    .join('')}Z`;
}

/** A logo on its card, centred on the origin */
export function Card({ logo, size = TILE }: { logo: Logo; size?: number }) {
  const glyph = (size * GLYPH) / TILE;
  return (
    <>
      <title>{logo.name}</title>
      <rect
        className="converge-tile"
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        rx={(size * 20) / TILE}
      />
      <path
        transform={`translate(${-glyph / 2} ${-glyph / 2}) scale(${glyph / 24})`}
        d={logo.d}
        fill={logo.fill}
      />
    </>
  );
}

/** The logos take the lanes in turn, spaced evenly along their lane */
function Drifting({ logo, i }: { logo: Logo; i: number }) {
  const index = i % LANES.length;
  const { pace, phase } = LANES[index] ?? { pace: 1, phase: 0 };
  const onLane = Math.ceil((LOGOS.length - index) / LANES.length);
  const dur = TRIP * pace;
  // Started part way through, so the stream is full from the first frame
  const begin = -dur * (Math.floor(i / LANES.length) / onLane + phase);
  const timing = { dur: `${dur}s`, begin: `${begin}s`, repeatCount: 'indefinite' };
  return (
    <g>
      <animateMotion {...timing}>
        <mpath href={`#lane-${index}`} />
      </animateMotion>
      <g>
        {/* Crushed as it reaches the glass */}
        <animateTransform
          attributeName="transform"
          type="scale"
          values="1;1;0.3"
          keyTimes="0;0.85;1"
          {...timing}
        />
        <Card logo={logo} />
      </g>
    </g>
  );
}

export function Converge() {
  // Asked for less motion, one logo waits at each lane's bend instead
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const span = EDGE.bottom - EDGE.top;
  return (
    <div className="converge">
      <svg
        viewBox="0 0 1200 520"
        role="img"
        aria-label={`${LOGOS.map((logo) => logo.name).join(', ')} drifting into one prism and coming out as Minca's colours`}
      >
        {SPECTRUM.map((fill, i) => {
          const n = SPECTRUM.length;
          return (
            <path
              key={fill}
              fill={fill}
              d={`M${at(OUT[0], OUT[1], i / n)}L${EDGE.x} ${EDGE.top + (span * i) / n}V${EDGE.top + (span * (i + 1)) / n}L${at(OUT[0], OUT[1], (i + 1) / n)}Z`}
            />
          );
        })}
        {LANES.map((point, i) => (
          <path key={point.y} id={`lane-${i}`} className="converge-beam" d={lane(point)} />
        ))}
        {still
          ? LANES.map((point, i) => {
              const logo = LOGOS[i];
              return logo ? (
                <g key={logo.name} transform={`translate(${point.x} ${point.y})`}>
                  <Card logo={logo} />
                </g>
              ) : null;
            })
          : LOGOS.map((logo, i) => <Drifting key={logo.name} logo={logo} i={i} />)}
        {/* The glass hides whatever goes into it */}
        <path className="converge-prism" d={rounded([PRISM.top, PRISM.right, PRISM.left])} />
        <path className="converge-inside" d={`M${IN[0]} ${IN[1]}L${OUT[0].join(' ')}L${OUT[1].join(' ')}Z`} />
      </svg>
    </div>
  );
}
