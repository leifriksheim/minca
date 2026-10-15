import { useEffect, useRef, useState } from 'react';
import { Shape, type RoundKind } from '@minca/app-shared/shapes';
import { shapeColours, type ShapeColour } from '@minca/app-shared/tokens';

/**
 * The front page's hero: many hands making one small app. A handful of
 * people, each a shape, share a canvas; one asks for a carpool and it appears,
 * the others use it at once, and when it fills up someone asks for a
 * waitlist and gets that too. Asking, using and changing, in one picture.
 *
 * The cursors find what they point at by `data-target`, measured on the
 * page, so they land on the right thing at any width.
 */

type Who = 'maya' | 'joe' | 'anna' | 'sam' | 'lea';

type Spot = readonly [number, number];

/** Where each cursor rests, as fractions of the canvas: around the app, or below it on a narrow one */
const PEOPLE: Readonly<
  Record<
    Who,
    { name: string; kind: RoundKind; colour: ShapeColour; inkLabel?: boolean; home: Spot; narrowHome: Spot }
  >
> = {
  maya: { name: 'Maya', kind: 'scallop', colour: 'cobalt', home: [0.12, 0.7], narrowHome: [0.08, 0.76] },
  joe: { name: 'Joe', kind: 'flower', colour: 'coral', home: [0.84, 0.18], narrowHome: [0.62, 0.74] },
  anna: { name: 'Anna', kind: 'clover', colour: 'sage', home: [0.88, 0.66], narrowHome: [0.7, 0.9] },
  sam: {
    name: 'Sam',
    kind: 'star',
    colour: 'peach',
    inkLabel: true,
    home: [0.16, 0.22],
    narrowHome: [0.3, 0.88],
  },
  lea: {
    name: 'Lea',
    kind: 'burst',
    colour: 'lilac',
    inkLabel: true,
    home: [0.76, 0.86],
    narrowHome: [0.42, 0.74],
  },
};
/** Below this width the app spans the canvas, and cursors rest under it */
const NARROW = 640;
const WHO: readonly Who[] = ['maya', 'joe', 'anna', 'sam', 'lea'];

type Seats = readonly [string, string, string];

interface Step {
  readonly ms: number;
  readonly say: string;
  /** What the ask box holds, and whether it is being typed right now */
  readonly prompt: string;
  readonly typing?: boolean;
  readonly app: 'none' | 'empty' | 'ride';
  readonly seats: Seats;
  readonly waitlist: 'none' | 'open' | 'joined';
  /** Where each cursor points, by `data-target`; anyone missing rests at home */
  readonly at: Partial<Record<Who, string>>;
  readonly click?: readonly Who[];
}

const NONE: Seats = ['', '', ''];
const TWO: Seats = ['Anna', 'Sam', ''];
const FULL: Seats = ['Anna', 'Sam', 'Maya'];
const ASK = 'A carpool for away games';
const CHANGE = 'Add a waitlist';
const ASKING = 'Maya asks for a carpool.';
const SEATS = 'Anna and Sam grab seats.';
const LAST_SEAT = 'Maya takes the last one.';
const MENDING = 'Full already. Lea asks for a waitlist.';
const MENDED = 'Anyone can change it, and everyone gets the change.';

const STEPS: readonly Step[] = [
  { ms: 900, say: ASKING, prompt: '', app: 'none', seats: NONE, waitlist: 'none', at: { maya: 'prompt' } },
  {
    ms: 1900,
    say: ASKING,
    prompt: ASK,
    typing: true,
    app: 'none',
    seats: NONE,
    waitlist: 'none',
    at: { maya: 'prompt' },
  },
  {
    ms: 800,
    say: ASKING,
    prompt: ASK,
    app: 'none',
    seats: NONE,
    waitlist: 'none',
    at: { maya: 'send' },
    click: ['maya'],
  },
  {
    ms: 1500,
    say: 'It’s there for everyone, straight away.',
    prompt: '',
    app: 'empty',
    seats: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
  },
  {
    ms: 1300,
    say: 'Joe offers a ride.',
    prompt: '',
    app: 'ride',
    seats: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
    click: ['joe'],
  },
  {
    ms: 1100,
    say: SEATS,
    prompt: '',
    app: 'ride',
    seats: NONE,
    waitlist: 'none',
    at: { anna: 'seat-0', sam: 'seat-1' },
  },
  {
    ms: 1100,
    say: SEATS,
    prompt: '',
    app: 'ride',
    seats: TWO,
    waitlist: 'none',
    at: { anna: 'seat-0', sam: 'seat-1' },
    click: ['anna', 'sam'],
  },
  { ms: 900, say: LAST_SEAT, prompt: '', app: 'ride', seats: TWO, waitlist: 'none', at: { maya: 'seat-2' } },
  {
    ms: 1300,
    say: LAST_SEAT,
    prompt: '',
    app: 'ride',
    seats: FULL,
    waitlist: 'none',
    at: { maya: 'seat-2' },
    click: ['maya'],
  },
  { ms: 900, say: MENDING, prompt: '', app: 'ride', seats: FULL, waitlist: 'none', at: { lea: 'prompt' } },
  {
    ms: 1500,
    say: MENDING,
    prompt: CHANGE,
    typing: true,
    app: 'ride',
    seats: FULL,
    waitlist: 'none',
    at: { lea: 'prompt' },
  },
  {
    ms: 800,
    say: MENDING,
    prompt: CHANGE,
    app: 'ride',
    seats: FULL,
    waitlist: 'none',
    at: { lea: 'send' },
    click: ['lea'],
  },
  { ms: 1100, say: MENDED, prompt: '', app: 'ride', seats: FULL, waitlist: 'open', at: { lea: 'join' } },
  {
    ms: 3200,
    say: MENDED,
    prompt: '',
    app: 'ride',
    seats: FULL,
    waitlist: 'joined',
    at: { lea: 'join' },
    click: ['lea'],
  },
];
const LAST = STEPS.length - 1;

/** The ask, typed out letter by letter; remounted each time, so it starts from nothing */
function Typed({ text }: { text: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((n) => Math.min(n + 1, text.length)), 45);
    return () => clearInterval(timer);
  }, [text]);
  return (
    <>
      {text.slice(0, count)}
      <i className="caret" />
    </>
  );
}

/** Someone in a seat, in the colour of their cursor; it keeps the seat's target, so the cursor stays put */
function Initial({ who, target }: { who: Who; target: string }) {
  const person = PEOPLE[who];
  return (
    <span
      data-target={target}
      className="app-initial"
      style={{ background: shapeColours[person.colour], color: person.inkLabel ? 'var(--ink)' : '#fff' }}
    >
      {person.name[0]}
    </span>
  );
}

const SEATED: Readonly<Record<string, Who>> = { Anna: 'anna', Sam: 'sam', Maya: 'maya' };

/** Each person is one of the brand's shapes, with their name beside it, the way a shared canvas shows who is where */
function Pointer({ who }: { who: Who }) {
  const person = PEOPLE[who];
  const fill = shapeColours[person.colour];
  return (
    <>
      <Shape kind={person.kind} colour={person.colour} className="cursor-shape" />
      <span
        className="cursor-name"
        style={{ background: fill, color: person.inkLabel ? 'var(--ink)' : '#fff' }}
      >
        {person.name}
      </span>
    </>
  );
}

export function HeroSpace() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [at, setAt] = useState({ step: still ? LAST : 0, round: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const cursors = useRef<Partial<Record<Who, HTMLDivElement | null>>>({});

  useEffect(() => {
    if (still) return;
    const timer = setTimeout(
      () =>
        setAt(({ step, round }) => (step < LAST ? { step: step + 1, round } : { step: 0, round: round + 1 })),
      STEPS[at.step]?.ms ?? 1000,
    );
    return () => clearTimeout(timer);
  }, [at, still]);

  const step = STEPS[at.step] ?? STEPS[LAST]!;

  // Move each cursor onto what it points at, or home; again whenever the canvas changes size
  useEffect(() => {
    const frame = canvas.current;
    if (!frame) return;
    const place = () => {
      const box = frame.getBoundingClientRect();
      for (const who of WHO) {
        const el = cursors.current[who];
        if (!el) continue;
        const name = step.at[who];
        const target = name ? frame.querySelector(`[data-target="${name}"]`) : null;
        const home = box.width < NARROW ? PEOPLE[who].narrowHome : PEOPLE[who].home;
        let x = box.width * home[0];
        let y = box.height * home[1];
        if (target) {
          const r = target.getBoundingClientRect();
          x = r.left - box.left + Math.min(r.width * 0.55, r.width - 6);
          y = r.top - box.top + r.height * 0.55;
        }
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(frame);
    return () => watch.disconnect();
  }, [step]);

  const full = step.seats.every(Boolean);
  const sending = Boolean(step.click?.length && step.prompt);

  return (
    <div className="canvas-wrap" aria-hidden>
      <div className="canvas" ref={canvas}>
        <div className="canvas-stack">
          <div className="ask" data-target="prompt">
            <span className="ask-text">
              {step.typing ? (
                <Typed key={`${at.round}-${at.step}`} text={step.prompt} />
              ) : (
                step.prompt || <span className="ask-hint">Ask for anything your group needs</span>
              )}
            </span>
            <span className={sending ? 'ask-send pressed' : 'ask-send'} data-target="send">
              Ask
            </span>
          </div>

          {step.app === 'none' ? null : (
            <div className="canvas-app" key={`app-${at.round}`}>
              <div className="app">
                <div className="app-head">
                  Carpool · Saturday away
                  <span>{step.app === 'empty' ? 'No rides yet' : full ? 'Full' : '1 ride'}</span>
                </div>
                {step.app === 'ride' ? (
                  <div className="app-row">
                    <span>
                      <b>Joe</b> is driving
                    </span>
                    <span className="app-seats">
                      {step.seats.map((name, i) => {
                        const who = SEATED[name];
                        return who ? (
                          <Initial key={i} who={who} target={`seat-${i}`} />
                        ) : (
                          <span key={i} className="app-seat" data-target={`seat-${i}`} />
                        );
                      })}
                    </span>
                  </div>
                ) : (
                  <div className="app-row">
                    <span>Driving on Saturday?</span>
                    <span className="app-pill free" data-target="offer">
                      Offer a ride
                    </span>
                  </div>
                )}
                {step.waitlist === 'none' ? null : (
                  <div className="app-row is-new">
                    <span>
                      <b>Waitlist</b>
                      <small>First in line gets a seat that opens</small>
                    </span>
                    {step.waitlist === 'joined' ? (
                      <Initial who="lea" target="join" />
                    ) : (
                      <span className="app-pill free" data-target="join">
                        Join
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {WHO.map((who) => (
          <div
            key={who}
            className={step.click?.includes(who) ? 'cursor clicking' : 'cursor'}
            ref={(el) => {
              cursors.current[who] = el;
            }}
          >
            <Pointer who={who} />
          </div>
        ))}
      </div>
      <p className="canvas-say" key={step.say}>
        {step.say}
      </p>
    </div>
  );
}
