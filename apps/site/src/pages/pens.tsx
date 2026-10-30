import { useEffect, useRef, type RefObject } from 'react';
import { shapeColours, type ShapeColour } from '@minca/ui/tokens';

/**
 * Companies start over, groups build on each other. Each tech billionaire
 * keeps your group in a pen of his own and guards the gate, his head a
 * cut-out photo that flaps as he talks, the way South Park draws famous
 * people. On Minca people hand each other bricks and build towers together.
 */

const GROUND = 290;

/** The scenes start when they're scrolled to, so the tower is seen going up; with less motion, they show the end */
function usePlayWhenSeen(ref: RefObject<SVGSVGElement | null>, end: number) {
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.pauseAnimations();
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      svg.setCurrentTime(end);
      return;
    }
    svg.setCurrentTime(0);
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        svg.unpauseAnimations();
        seen.disconnect();
      },
      { threshold: 0.4 },
    );
    seen.observe(svg);
    return () => seen.disconnect();
  }, [ref, end]);
}

/**
 * The billionaires, their faces from Wikimedia Commons (credited under the
 * picture), and the people each one keeps
 */
const PENS: ReadonlyArray<{
  id: string;
  name: string;
  suit: string;
  shirt: string;
  /** How far down his photo his mouth is */
  mouth: number;
  flag: string;
  kept: readonly [string, string];
}> = [
  {
    id: 'zuckerberg',
    name: 'Mark Zuckerberg',
    suit: '#6f7a91',
    shirt: '#6f7a91',
    mouth: 0.73,
    flag: '#0866ff',
    kept: ['maya', 'joe'],
  },
  {
    id: 'musk',
    name: 'Elon Musk',
    suit: '#1f2440',
    shirt: '#ffffff',
    mouth: 0.78,
    flag: '#26262b',
    kept: ['anna', 'sam'],
  },
  {
    id: 'bezos',
    name: 'Jeff Bezos',
    suit: '#2c3654',
    shirt: '#cfe0f2',
    mouth: 0.76,
    flag: '#ff9900',
    kept: ['kai', 'ola'],
  },
];

/** The photos' credits, as their licences ask */
export const PHOTO_CREDITS: ReadonlyArray<{ who: string; by: string; licence: string; href: string }> = [
  {
    who: 'Zuckerberg',
    by: 'Anthony Quintano',
    licence: 'CC BY 2.0',
    href: 'https://commons.wikimedia.org/wiki/File:Mark_Zuckerberg_F8_2019_Keynote_(32830578717)_(cropped).jpg',
  },
  {
    who: 'Musk',
    by: 'Debbie Rowe',
    licence: 'CC BY-SA 3.0',
    href: 'https://commons.wikimedia.org/wiki/File:Elon_Musk_Royal_Society_(crop2).jpg',
  },
  {
    who: 'Bezos',
    by: 'Seattle City Council',
    licence: 'CC BY 2.0',
    href: 'https://commons.wikimedia.org/wiki/File:Jeff_Bezos_at_Amazon_Spheres_Grand_Opening_in_Seattle_-_2018_(39074799225)_(cropped).jpg',
  },
];

/**
 * A guard: his photo, cut out, on a cartoon body. The photo is cut across at
 * his mouth (a fraction of the way down it) and the top lifts as he talks.
 */
const HEAD = 76;
const BODY = 64;

function Guard({
  id,
  suit,
  shirt,
  mouth,
  x,
  i,
}: {
  id: string;
  suit: string;
  shirt: string;
  mouth: number;
  x: number;
  i: number;
}) {
  const line = -HEAD + mouth * HEAD;
  const photo = <image href={`/faces/${id}.png`} x={-HEAD / 2} y={-HEAD} width={HEAD} height={HEAD} />;
  return (
    <g transform={`translate(${x} ${GROUND - BODY})`}>
      {/* Trims what the cut-out kept around the head, a collar or a microphone */}
      <clipPath id={`${id}-head`}>
        <ellipse cx={0} cy={-HEAD / 2} rx={HEAD * 0.42} ry={HEAD / 2} />
      </clipPath>
      <clipPath id={`${id}-top`}>
        <rect x={-HEAD} y={-HEAD * 2} width={HEAD * 2} height={HEAD * 2 + line} />
      </clipPath>
      <clipPath id={`${id}-bottom`}>
        <rect x={-HEAD} y={line} width={HEAD * 2} height={HEAD} />
      </clipPath>
      {/* A suit, arms folded: he isn't going anywhere */}
      <Body top={suit} />
      <path className="pens-line" d="M-9 -6L0 12L9 -6Z" fill={shirt} />
      <rect className="pens-line" x={-25} y={20} width={50} height={13} rx={6.5} fill={suit} />
      <rect x={-HEAD * 0.2} y={line - 7} width={HEAD * 0.4} height={9} rx={4.5} fill="#3a1414" />
      <g clipPath={`url(#${id}-head)`}>
        <g clipPath={`url(#${id}-bottom)`}>{photo}</g>
      </g>
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0;0 -9;0 0;0 -6;0 0;0 0"
          keyTimes="0;0.15;0.3;0.45;0.6;1"
          dur="1.4s"
          begin={`${-i * 0.45}s`}
          repeatCount="indefinite"
        />
        <g clipPath={`url(#${id}-head)`}>
          <g clipPath={`url(#${id}-top)`}>{photo}</g>
        </g>
      </g>
    </g>
  );
}

/** Someone kept in a pen, hopping to see over the fence; builders only bob */
function Kept({ who, x, i, hop = 16 }: { who: string; x: number; i: number; hop?: number }) {
  return (
    <g>
      <animateTransform
        attributeName="transform"
        type="translate"
        values={`0 0;0 0;0 ${-hop};0 0`}
        keyTimes="0;0.6;0.75;1"
        dur="1.8s"
        begin={`${-i * 0.7}s`}
        repeatCount="indefinite"
      />
      <Person who={who} x={x} />
    </g>
  );
}

/** Legs and a torso, under a head of HEAD with its chin at the origin */
function Body({ top }: { top: string }) {
  return (
    <>
      <rect className="pens-line" x={-12} y={44} width={10} height={20} rx={3} fill="#2b2b33" />
      <rect className="pens-line" x={2} y={44} width={10} height={20} rx={3} fill="#2b2b33" />
      <path className="pens-line" d="M-28 14Q-28 -4 -10 -6H10Q28 -4 28 14V46H-28Z" fill={top} />
    </>
  );
}

/**
 * Someone from the demos, standing: their photo cut out to the head, all at
 * the same size with the chin at the same place (`public/faces/cut/`), on the
 * guards' body in the colour of what they're wearing, a little smaller
 */
const TOPS: Readonly<Record<string, string>> = {
  maya: '#a3122a',
  joe: '#f3f1ee',
  anna: '#e8eef6',
  sam: '#3d3d40',
  kai: '#1c2140',
  ola: '#2a3350',
  lea: '#a24a22',
  leo: '#7a7d80',
  ben: '#3c4630',
  ida: '#3a3d48',
};
/** How much smaller than a guard everyone else is drawn */
const SMALL = 0.62;
/** Where the chin is in a cut-out, as a fraction of its height */
const CHIN = 0.9;

function Person({ who, x }: { who: string; x: number }) {
  return (
    <g transform={`translate(${x} ${GROUND}) scale(${SMALL}) translate(0 ${-BODY})`}>
      <clipPath id={`${who}-head`}>
        <ellipse cx={0} cy={-HEAD * CHIN * 0.5} rx={HEAD * 0.4} ry={HEAD * CHIN * 0.52} />
      </clipPath>
      <Body top={TOPS[who] ?? 'var(--card)'} />
      <image
        href={`/faces/cut/${who}.png`}
        x={-HEAD / 2}
        y={-HEAD * CHIN}
        width={HEAD}
        height={HEAD}
        clipPath={`url(#${who}-head)`}
      />
    </g>
  );
}

/** A pen: bars in front of whoever is inside, low enough for their heads, and a flag in his colours */
const PEN = { half: 52, bars: 6, height: 40 };

function Fence({ cx, flag }: { cx: number; flag: string }) {
  const step = (PEN.half * 2) / (PEN.bars - 1);
  const bars = Array.from({ length: PEN.bars }, (_, i) => cx - PEN.half + i * step);
  const top = GROUND - PEN.height;
  return (
    <g>
      <path
        className="pens-line"
        d={`M${cx - PEN.half} ${top + 8}H${cx + PEN.half}M${cx - PEN.half} ${GROUND - 10}H${cx + PEN.half}`}
      />
      {bars.map((x) => (
        <path
          key={x}
          className="pens-picket"
          d={`M${x - 3} ${GROUND}V${top}L${x} ${top - 7}L${x + 3} ${top}V${GROUND}Z`}
        />
      ))}
      <path className="pens-line" d={`M${cx} ${top - 7}V${top - 64}`} />
      <path d={`M${cx} ${top - 64}L${cx + 22} ${top - 56}L${cx} ${top - 48}Z`} fill={flag} />
    </g>
  );
}

/** Every company: a pen each, your group inside, and him at the gate */
export function Pens() {
  const ref = useRef<SVGSVGElement>(null);
  usePlayWhenSeen(ref, 1);
  return (
    <svg
      ref={ref}
      viewBox="-30 40 560 320"
      role="img"
      aria-label="Mark Zuckerberg, Elon Musk and Jeff Bezos each guard a fenced pen with people shut inside"
    >
      <path className="pens-line" d={`M-30 ${GROUND}H530`} />
      {PENS.map((pen, i) => {
        const cx = 50 + i * 168;
        return (
          <g key={pen.id}>
            <title>{pen.name}</title>
            {pen.kept.map((who, j) => (
              <Kept key={who} who={who} x={cx - 20 + j * 40} i={i * 2 + j} />
            ))}
            <Fence cx={cx} flag={pen.flag} />
            <Guard
              id={pen.id}
              suit={pen.suit}
              shirt={pen.shirt}
              mouth={pen.mouth}
              x={cx + PEN.half + 38}
              i={i}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Who stands between the towers, and where */
const BUILDERS = [
  { who: 'maya', x: -5 },
  { who: 'joe', x: 140 },
  { who: 'anna', x: 180 },
  { who: 'sam', x: 320 },
  { who: 'lea', x: 360 },
  { who: 'ben', x: 505 },
] as const;
const TOWERS = [70, 250, 430] as const;
/**
 * The bricks in the order they go up: which tower, who hands it over and who
 * takes it and lays it (always someone standing beside that tower)
 */
const BRICKS: ReadonlyArray<{ adds: string; colour: ShapeColour; tower: number; from: number; to: number }> =
  [
    { adds: 'RSVP', colour: 'coral', tower: 0, from: 2, to: 1 },
    { adds: 'Chat', colour: 'cobalt', tower: 1, from: 4, to: 3 },
    { adds: 'Rota', colour: 'peach', tower: 2, from: 3, to: 4 },
    { adds: 'Waitlist', colour: 'sage', tower: 0, from: 1, to: 0 },
    { adds: 'Polls', colour: 'lilac', tower: 1, from: 1, to: 2 },
    { adds: 'Swaps', colour: 'coral', tower: 2, from: 4, to: 5 },
    { adds: 'Talks', colour: 'cobalt', tower: 0, from: 0, to: 1 },
    { adds: 'Map', colour: 'peach', tower: 1, from: 2, to: 3 },
    { adds: 'Chores', colour: 'sage', tower: 2, from: 5, to: 4 },
    { adds: 'Reminders', colour: 'lilac', tower: 0, from: 2, to: 1 },
    { adds: 'Photos', colour: 'coral', tower: 1, from: 4, to: 3 },
    { adds: 'Carpool', colour: 'cobalt', tower: 2, from: 3, to: 4 },
  ];
const BRICK = { width: 88, height: 28, gap: 0.75 };
/** Where a brick is held, above the ground */
const HANDS = 48;
/** How big a brick is in someone's hands, before it's laid */
const HELD = 0.5;

/** On Minca: people between three towers hand each other bricks, and whoever is beside a tower lays them */
export function Tower() {
  const ref = useRef<SVGSVGElement>(null);
  usePlayWhenSeen(ref, 0.4 + BRICKS.length * BRICK.gap + 1.2);
  return (
    <svg
      ref={ref}
      viewBox="-30 40 560 320"
      role="img"
      aria-label="People standing between three towers hand each other bricks, RSVP, Chat, Polls, Carpool and more, and build the towers together"
    >
      <path className="pens-line" d={`M-30 ${GROUND}H530`} />
      {BUILDERS.map((builder, i) => (
        <Kept key={builder.who} who={builder.who} x={builder.x} i={i} hop={4} />
      ))}
      {BRICKS.map((brick, i) => {
        const level = BRICKS.slice(0, i).filter((below) => below.tower === brick.tower).length;
        const x = (TOWERS[brick.tower] ?? 0) + (level % 2 ? 4 : -4);
        const y = GROUND - BRICK.height * (level + 0.5);
        const from = { x: (BUILDERS[brick.from]?.x ?? 0) - x, y: GROUND - HANDS - y };
        const to = { x: (BUILDERS[brick.to]?.x ?? 0) - x, y: from.y };
        const path = `M${from.x} ${from.y}Q${(from.x + to.x) / 2} ${from.y - 30} ${to.x} ${to.y}Q${to.x / 2} ${Math.min(to.y, 0) - 60} 0 0`;
        const timing = { begin: `${0.4 + i * BRICK.gap}s`, dur: '1.2s', fill: 'freeze' as const };
        return (
          <g key={brick.adds} transform={`translate(${x} ${y})`}>
            <g opacity={0}>
              <animate attributeName="opacity" values="0;1;1" keyTimes="0;0.1;1" {...timing} />
              <animateMotion path={path} {...timing} />
              <g>
                <animateTransform
                  attributeName="transform"
                  type="scale"
                  values={`${HELD};${HELD};1`}
                  keyTimes="0;0.4;1"
                  {...timing}
                />
                <rect
                  className="pens-line"
                  x={-BRICK.width / 2}
                  y={-BRICK.height / 2}
                  width={BRICK.width}
                  height={BRICK.height}
                  rx={6}
                  fill={`color-mix(in srgb, ${shapeColours[brick.colour]} 70%, var(--card))`}
                />
                <text className="pens-brick">{brick.adds}</text>
              </g>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
