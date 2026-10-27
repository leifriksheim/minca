import { useEffect, useRef, useState } from 'react';
import { shapeColours, type ShapeColour } from '@minca/ui/tokens';
import { EventHead, Face } from './demos';

/**
 * The front page's hero: many hands making one small app. A handful of
 * people, each a face, share a canvas; one asks for an RSVP for hack night and
 * it appears, the others use it at once, and when it fills up someone asks
 * for a waitlist and gets that too. Asking, using and changing, in one picture.
 *
 * The cursors find what they point at by `data-target`, measured on the
 * page, so they land on the right thing at any width.
 */

type Who = 'maya' | 'joe' | 'anna' | 'sam' | 'lea';

type Spot = readonly [number, number];

/** Where each cursor rests, as fractions of the canvas: around the app, or below it on a narrow one */
const PEOPLE: Readonly<
  Record<Who, { name: string; colour: ShapeColour; inkLabel?: boolean; home: Spot; narrowHome: Spot }>
> = {
  maya: { name: 'Maya', colour: 'cobalt', home: [0.12, 0.7], narrowHome: [0.08, 0.76] },
  joe: { name: 'Joe', colour: 'coral', home: [0.84, 0.18], narrowHome: [0.62, 0.74] },
  anna: { name: 'Anna', colour: 'sage', home: [0.88, 0.66], narrowHome: [0.7, 0.9] },
  sam: {
    name: 'Sam',
    colour: 'peach',
    inkLabel: true,
    home: [0.16, 0.22],
    narrowHome: [0.3, 0.88],
  },
  lea: {
    name: 'Lea',
    colour: 'lilac',
    inkLabel: true,
    home: [0.76, 0.86],
    narrowHome: [0.42, 0.74],
  },
};
/** Below this width the app spans the canvas, and cursors rest under it */
const NARROW = 640;
const WHO: readonly Who[] = ['maya', 'joe', 'anna', 'sam', 'lea'];

type Spots = readonly [string, string, string];

interface Step {
  readonly ms: number;
  /** What the ask box holds, and whether it is being typed right now */
  readonly prompt: string;
  readonly typing?: boolean;
  readonly app: 'none' | 'empty' | 'event';
  readonly spots: Spots;
  readonly waitlist: 'none' | 'open' | 'joined';
  /** Where each cursor points, by `data-target`; anyone missing rests at home */
  readonly at: Partial<Record<Who, string>>;
  readonly click?: readonly Who[];
}

const NONE: Spots = ['', '', ''];
const TWO: Spots = ['Anna', 'Sam', ''];
const FULL: Spots = ['Anna', 'Sam', 'Maya'];
const ASK = 'An RSVP for our hack night';
const CHANGE = 'Add a waitlist';

const STEPS: readonly Step[] = [
  { ms: 900, prompt: '', app: 'none', spots: NONE, waitlist: 'none', at: { maya: 'prompt' } },
  {
    ms: 1900,
    prompt: ASK,
    typing: true,
    app: 'none',
    spots: NONE,
    waitlist: 'none',
    at: { maya: 'prompt' },
  },
  {
    ms: 800,
    prompt: ASK,
    app: 'none',
    spots: NONE,
    waitlist: 'none',
    at: { maya: 'send' },
    click: ['maya'],
  },
  {
    ms: 1500,
    prompt: '',
    app: 'empty',
    spots: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
  },
  {
    ms: 1300,
    prompt: '',
    app: 'event',
    spots: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
    click: ['joe'],
  },
  {
    ms: 1100,
    prompt: '',
    app: 'event',
    spots: NONE,
    waitlist: 'none',
    at: { anna: 'spot-0', sam: 'spot-1' },
  },
  {
    ms: 1100,
    prompt: '',
    app: 'event',
    spots: TWO,
    waitlist: 'none',
    at: { anna: 'spot-0', sam: 'spot-1' },
    click: ['anna', 'sam'],
  },
  { ms: 900, prompt: '', app: 'event', spots: TWO, waitlist: 'none', at: { maya: 'spot-2' } },
  {
    ms: 1300,
    prompt: '',
    app: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { maya: 'spot-2' },
    click: ['maya'],
  },
  { ms: 900, prompt: '', app: 'event', spots: FULL, waitlist: 'none', at: { lea: 'prompt' } },
  {
    ms: 1500,
    prompt: CHANGE,
    typing: true,
    app: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { lea: 'prompt' },
  },
  {
    ms: 800,
    prompt: CHANGE,
    app: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { lea: 'send' },
    click: ['lea'],
  },
  { ms: 1100, prompt: '', app: 'event', spots: FULL, waitlist: 'open', at: { lea: 'join' } },
  {
    ms: 3200,
    prompt: '',
    app: 'event',
    spots: FULL,
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

const TAKEN: Readonly<Record<string, Who>> = { Anna: 'anna', Sam: 'sam', Maya: 'maya' };

/** Each person is their face, ringed in their colour, with their name beside it, the way a shared canvas shows who is where */
function Pointer({ who }: { who: Who }) {
  const person = PEOPLE[who];
  const fill = shapeColours[person.colour];
  return (
    <>
      <img className="cursor-face" src={`/faces/${who}.jpg`} alt="" style={{ borderColor: fill }} />
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
  /** Whether the cursors have come in from the sides yet */
  const entered = useRef(false);

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
      const page = document.documentElement.clientWidth;
      const entering = !entered.current && !still;
      entered.current = true;
      for (const [i, who] of WHO.entries()) {
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
        if (entering) {
          // Start past the page's edge on the side it rests on, then walk in, one after another
          const side = (box.width < NARROW ? PEOPLE[who].narrowHome : PEOPLE[who].home)[0] < 0.5;
          el.style.transition = 'none';
          el.style.transform = `translate(${side ? -box.left - 80 : page - box.left + 20}px, ${y}px)`;
          el.getBoundingClientRect();
          el.style.transition = '';
          el.style.transitionDelay = `${0.2 + i * 0.15}s`;
        } else {
          el.style.transitionDelay = '';
        }
        el.style.transform = `translate(${x}px, ${y}px)`;
        // Near the right edge the name goes on the face's left, so it stays on the page
        el.classList.toggle('is-flipped', x > box.width - 90);
      }
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(frame);
    return () => watch.disconnect();
  }, [step, still]);

  const full = step.spots.every(Boolean);
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
              Create
            </span>
          </div>

          {step.app === 'none' ? null : (
            <div className="canvas-app" key={`app-${at.round}`}>
              <div className="app">
                <EventHead
                  day="Thu"
                  date="14"
                  title="Hack night"
                  meta={step.app === 'empty' ? '7pm · no host yet' : '7pm · The Loft · Joe hosts'}
                />
                {step.app === 'event' ? (
                  <div className="app-row">
                    <span>
                      <b>Going</b>
                      <small>{full ? 'Full' : `${step.spots.filter(Boolean).length} of 3 spots`}</small>
                    </span>
                    <span className="app-spots">
                      {step.spots.map((name, i) => {
                        const who = TAKEN[name];
                        return who ? (
                          <Face key={i} who={who} target={`spot-${i}`} />
                        ) : (
                          <span key={i} className="app-spot" data-target={`spot-${i}`} />
                        );
                      })}
                    </span>
                  </div>
                ) : (
                  <div className="app-row">
                    <span>Who’s hosting?</span>
                    <span className="app-pill free" data-target="offer">
                      Host it
                    </span>
                  </div>
                )}
                {step.waitlist === 'none' ? null : (
                  <div className="app-row is-new">
                    <span>
                      <b>Waitlist</b>
                      <small>First in line gets a spot that opens</small>
                    </span>
                    {step.waitlist === 'joined' ? (
                      <Face who="lea" target="join" />
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
    </div>
  );
}
