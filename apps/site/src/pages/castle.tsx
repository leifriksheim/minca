import { MARK_BANDS } from '@minca/app-shared/mark';
import { PATHS, type ShapeKind } from '@minca/ui/shapes';
import { shapeColours, type ShapeColour } from '@minca/ui/tokens';
import { Card } from './converge';
import { CLAUDE, LOGOS } from './converge-logos';

/**
 * Where the AI stands. Elsewhere it sits between you and every app, and
 * everything you have passes through it. On Minca the group is a castle:
 * the AI builds outside the moat and leaves the tool by the drawbridge, and
 * the group lowers the bridge, pulls the tool in and raises it again.
 */

const named = (name: string) => LOGOS.find((logo) => logo.name === name);
const CONNECTED = ['Notion', 'Google Drive', 'Google Calendar', 'Gmail'].flatMap((name) => named(name) ?? []);

/** You, round, from the faces the other demos use */
function You({ x, y, r, who }: { x: number; y: number; r: number; who: string }) {
  const id = `face-${who}-${x}`;
  return (
    <g>
      <clipPath id={id}>
        <circle cx={x} cy={y} r={r} />
      </clipPath>
      <image
        href={`/faces/${who}.jpg`}
        x={x - r}
        y={y - r}
        width={r * 2}
        height={r * 2}
        clipPath={`url(#${id})`}
        preserveAspectRatio="xMidYMid slice"
      />
      <circle className="castle-line" cx={x} cy={y} r={r} />
    </g>
  );
}

/** Elsewhere: you, the AI, and the apps it reaches into, your data running through it both ways */
export function Middle() {
  const you = { x: 60, y: 190 };
  const ai = { x: 240, y: 190 };
  const through = (y: number) => `M${you.x} ${you.y}H${ai.x}C${ai.x + 90} ${you.y} ${330} ${y} ${440} ${y}`;
  return (
    <svg
      viewBox="-30 40 560 320"
      role="img"
      aria-label="An AI in the middle, reading everything between you and your apps"
    >
      {CONNECTED.map((logo, i) => {
        const y = 70 + i * 80;
        return (
          <g key={logo.name}>
            <path id={`through-${i}`} className="castle-wire" d={through(y)} />
            {/* Your things out to the app, and the app's back to you, both through the middle */}
            <circle r={5} fill={logo.fill}>
              <animateMotion dur="3s" begin={`${-i * 0.75}s`} repeatCount="indefinite">
                <mpath href={`#through-${i}`} />
              </animateMotion>
            </circle>
            <circle r={5} className="castle-dot">
              <animateMotion
                dur="3s"
                begin={`${-i * 0.75 - 1.5}s`}
                repeatCount="indefinite"
                keyPoints="1;0"
                keyTimes="0;1"
                calcMode="linear"
              >
                <mpath href={`#through-${i}`} />
              </animateMotion>
            </circle>
            <g transform={`translate(452 ${y})`}>
              <Card logo={logo} size={56} />
            </g>
          </g>
        );
      })}
      <You x={you.x} y={you.y} r={30} who="maya" />
      <g transform={`translate(${ai.x} ${ai.y})`}>
        <Card logo={CLAUDE} size={84} />
      </g>
    </svg>
  );
}

/** One loop of the castle: the AI walks up, the bridge comes down, the tool goes in, the bridge goes up */
const LOOP = 8;
const GROUND = 290;
const HINGE = { x: 300, y: GROUND };
const BRIDGE = 100;
/** The rainbow behind the castle: as wide as it (the mark's bands reach 11.5 either side), standing above the ground */
const ARCH = { scale: 100 / 11.5, base: 168 };
/** When the bridge starts and ends coming down, and going up, as fractions of a loop */
const DOWN = [0.45, 0.55] as const;
const UP = [0.78, 0.88] as const;

/** The tools the AI brings, one a loop */
const TOOLS: ReadonlyArray<{ kind: ShapeKind; colour: ShapeColour }> = [
  { kind: 'flower', colour: 'sage' },
  { kind: 'clover', colour: 'coral' },
  { kind: 'star', colour: 'peach' },
];

/** The bridge's free end at an angle, 0 lying across the moat and 90 standing up */
const tip = (angle: number) => {
  const a = (angle * Math.PI) / 180;
  return { x: HINGE.x - BRIDGE * Math.cos(a), y: HINGE.y - BRIDGE * Math.sin(a) };
};

/** The chain follows the bridge's end in steps, so it stays on the arc rather than cutting across it */
function chainFrames() {
  const steps = 6;
  const frames: Array<{ t: number; angle: number }> = [{ t: 0, angle: 90 }];
  for (let i = 0; i <= steps; i++)
    frames.push({ t: DOWN[0] + ((DOWN[1] - DOWN[0]) * i) / steps, angle: 90 * (1 - i / steps) });
  for (let i = 0; i <= steps; i++)
    frames.push({ t: UP[0] + ((UP[1] - UP[0]) * i) / steps, angle: (90 * i) / steps });
  frames.push({ t: 1, angle: 90 });
  const points = frames.map((frame) => tip(frame.angle));
  return {
    keyTimes: frames.map((frame) => frame.t.toFixed(4)).join(';'),
    x: points.map((point) => point.x.toFixed(1)).join(';'),
    y: points.map((point) => point.y.toFixed(1)).join(';'),
  };
}

/** Where a tool is through its loop: carried, set down by the moat, pulled across, gone in */
const TOOL_PATH = [
  { t: 0, x: 104, y: 232 },
  { t: 0.2, x: 174, y: 232 },
  { t: 0.25, x: 172, y: 268 },
  { t: 0.58, x: 172, y: 268 },
  { t: 0.72, x: 322, y: 268 },
  { t: 1, x: 322, y: 268 },
];

function Tool({ kind, colour, i }: { kind: ShapeKind; colour: ShapeColour; i: number }) {
  // Each tool's own loop is three of the castle's, and it shows in the first
  const timing = { dur: `${LOOP * TOOLS.length}s`, begin: `${i * LOOP}s`, repeatCount: 'indefinite' };
  const at = (t: number) => (t / TOOLS.length).toFixed(4);
  return (
    <g opacity={0}>
      <animate
        attributeName="opacity"
        values="1;1;0;0"
        keyTimes={`0;${at(0.72)};${at(0.76)};1`}
        {...timing}
      />
      <animateTransform
        attributeName="transform"
        type="translate"
        values={TOOL_PATH.map((step) => `${step.x} ${step.y}`).join(';')}
        keyTimes={TOOL_PATH.map((step) => (step.t === 1 ? '1' : at(step.t))).join(';')}
        {...timing}
      />
      <path transform="translate(-18 -18) scale(0.36)" d={PATHS[kind]} fill={shapeColours[colour]} />
    </g>
  );
}

/** On Minca: the group's castle, the moat, and the AI outside it with a tool for them */
export function Castle() {
  const chain = chainFrames();
  const raised = `90 ${HINGE.x} ${HINGE.y}`;
  const lowered = `0 ${HINGE.x} ${HINGE.y}`;
  const timing = { dur: `${LOOP}s`, repeatCount: 'indefinite' };
  return (
    <svg
      viewBox="0 40 560 320"
      role="img"
      aria-label="An AI outside a castle leaves a tool by the moat; the group lowers the drawbridge, takes it in and raises the bridge again"
    >
      {/* Minca's rainbow, rising behind the castle */}
      <g
        transform={`translate(${400 - 12 * ARCH.scale} ${ARCH.base - 12.5 * ARCH.scale}) scale(${ARCH.scale})`}
      >
        {MARK_BANDS.map((band) => (
          <path key={band.fill} d={band.d} fill={band.fill} />
        ))}
      </g>

      {/* The moat, and the ground either side of it */}
      <path
        className="castle-water"
        d={`M200 ${GROUND + 14}Q225 ${GROUND + 8} 250 ${GROUND + 14}T300 ${GROUND + 14}V345H200Z`}
      />
      <path className="castle-line" d={`M0 ${GROUND}H200V345H300V${GROUND}H560`} />

      {/* The group, looking over the wall */}
      <You x={378} y={150} r={12} who="joe" />
      <You x={404} y={146} r={12} who="anna" />
      <You x={430} y={150} r={12} who="sam" />

      {/* The castle: two towers and the wall between, with a gate in the near tower */}
      <g className="castle-stone">
        <rect x={350} y={172} width={100} height={GROUND - 172} rx={4} />
        {[356, 384, 412, 440].map((x) => (
          <rect key={x} x={x} y={160} width={16} height={18} rx={3} />
        ))}
        {[300, 450].map((x) => (
          <g key={x}>
            <rect x={x} y={130} width={50} height={GROUND - 130} rx={6} />
            {[0, 18, 36].map((dx) => (
              <rect key={dx} x={x + dx} y={116} width={14} height={20} rx={3} />
            ))}
          </g>
        ))}
      </g>
      <path className="castle-gate" d={`M308 ${GROUND}V238A17 17 0 0 1 342 238V${GROUND}Z`} />

      {/* The drawbridge, hinged at the gate, and its chain */}
      <line className="castle-chain" x1={HINGE.x} y1={176}>
        <animate attributeName="x2" values={chain.x} keyTimes={chain.keyTimes} {...timing} />
        <animate attributeName="y2" values={chain.y} keyTimes={chain.keyTimes} {...timing} />
      </line>
      <g>
        <animateTransform
          attributeName="transform"
          type="rotate"
          values={[raised, raised, lowered, lowered, raised, raised].join(';')}
          keyTimes={`0;${DOWN[0]};${DOWN[1]};${UP[0]};${UP[1]};1`}
          {...timing}
        />
        <rect
          className="castle-bridge"
          x={HINGE.x - BRIDGE}
          y={GROUND - 4}
          width={BRIDGE}
          height={8}
          rx={3}
        />
      </g>

      {TOOLS.map((tool, i) => (
        <Tool key={tool.kind} {...tool} i={i} />
      ))}

      {/* The AI, walking up with the tool and back again; it never crosses */}
      <g>
        <animateTransform
          attributeName="transform"
          type="translate"
          values={`60 250;130 250;130 250;60 250;60 250`}
          keyTimes="0;0.2;0.3;0.45;1"
          {...timing}
        />
        <Card logo={CLAUDE} size={64} />
      </g>
    </svg>
  );
}
