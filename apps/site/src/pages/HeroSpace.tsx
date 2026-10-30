import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader } from '@minca/app-shared/Loader';
import { Mark } from '@minca/app-shared/Wordmark';
import { Shape } from '@minca/app-shared/shapes';
import { TOOL_SHAPES, type ShapeKind } from '@minca/ui/shapes';
import { shapeColours, type ShapeColour } from '@minca/ui/tokens';
import { EventHead, Face } from './demos';

/**
 * The front page's hero: many hands making one small tool, inside Minca as it
 * looks on a laptop. A handful of people, each a face, share a space; one
 * asks their agent, in a prompt box above the window, for an RSVP
 * for hack night, and it appears in the space, in its sidebar too. The others
 * use it at once, and when it fills up someone asks for a waitlist and gets
 * that too. Asking, using and changing, in one picture.
 *
 * The cursors find what they point at by `data-target`, measured on the
 * page, so they land on the right thing at any width.
 */

type Who = 'maya' | 'joe' | 'anna' | 'sam' | 'lea';

type Spot = readonly [number, number];

/** Where each cursor rests, as fractions of the canvas: either side of the tool, or below it on a narrow one */
const PEOPLE: Readonly<
  Record<Who, { name: string; colour: ShapeColour; inkLabel?: boolean; home: Spot; narrowHome: Spot }>
> = {
  maya: { name: 'Maya', colour: 'cobalt', home: [0.36, 0.62], narrowHome: [0.06, 0.62] },
  joe: { name: 'Joe', colour: 'coral', home: [0.9, 0.22], narrowHome: [0.6, 0.86] },
  anna: { name: 'Anna', colour: 'sage', home: [0.92, 0.6], narrowHome: [0.74, 0.64] },
  sam: {
    name: 'Sam',
    colour: 'peach',
    inkLabel: true,
    home: [0.37, 0.3],
    narrowHome: [0.26, 0.86],
  },
  lea: {
    name: 'Lea',
    colour: 'lilac',
    inkLabel: true,
    home: [0.86, 0.84],
    narrowHome: [0.42, 0.64],
  },
};
/** Below this width the window drops its sidebar (site.css), the tool spans it, and cursors rest under it */
const NARROW = 760;
const WHO: readonly Who[] = ['maya', 'joe', 'anna', 'sam', 'lea'];

type Spots = readonly [string, string, string];

interface Step {
  readonly ms: number;
  /** What the ask box holds, and whether it is being typed right now */
  readonly prompt: string;
  readonly typing?: boolean;
  readonly tool: 'none' | 'empty' | 'event';
  /** What the agent says it is doing, under the prompt, once it has been sent */
  readonly building?: string;
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
  { ms: 900, prompt: '', tool: 'none', spots: NONE, waitlist: 'none', at: { maya: 'prompt' } },
  {
    ms: 1900,
    prompt: ASK,
    typing: true,
    tool: 'none',
    spots: NONE,
    waitlist: 'none',
    at: { maya: 'prompt' },
  },
  {
    ms: 800,
    prompt: ASK,
    tool: 'none',
    spots: NONE,
    waitlist: 'none',
    at: { maya: 'send' },
    click: ['maya'],
  },
  {
    ms: 1500,
    prompt: '',
    building: 'Adding Hack night to Riverside Makers',
    tool: 'empty',
    spots: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
  },
  {
    ms: 1300,
    prompt: '',
    tool: 'event',
    spots: NONE,
    waitlist: 'none',
    at: { joe: 'offer' },
    click: ['joe'],
  },
  {
    ms: 1100,
    prompt: '',
    tool: 'event',
    spots: NONE,
    waitlist: 'none',
    at: { anna: 'spot-0', sam: 'spot-1' },
  },
  {
    ms: 1100,
    prompt: '',
    tool: 'event',
    spots: TWO,
    waitlist: 'none',
    at: { anna: 'spot-0', sam: 'spot-1' },
    click: ['anna', 'sam'],
  },
  { ms: 900, prompt: '', tool: 'event', spots: TWO, waitlist: 'none', at: { maya: 'spot-2' } },
  {
    ms: 1300,
    prompt: '',
    tool: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { maya: 'spot-2' },
    click: ['maya'],
  },
  { ms: 900, prompt: '', tool: 'event', spots: FULL, waitlist: 'none', at: { lea: 'prompt' } },
  {
    ms: 1500,
    prompt: CHANGE,
    typing: true,
    tool: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { lea: 'prompt' },
  },
  {
    ms: 800,
    prompt: CHANGE,
    tool: 'event',
    spots: FULL,
    waitlist: 'none',
    at: { lea: 'send' },
    click: ['lea'],
  },
  {
    ms: 1100,
    prompt: '',
    building: 'Adding a waitlist to Hack night',
    tool: 'event',
    spots: FULL,
    waitlist: 'open',
    at: { lea: 'join' },
  },
  {
    ms: 3200,
    prompt: '',
    tool: 'event',
    spots: FULL,
    waitlist: 'joined',
    at: { lea: 'join' },
    click: ['lea'],
  },
];
const LAST = STEPS.length - 1;

/** The ask, typed out letter by letter; remounted each time, so it starts from nothing */
export function Typed({ text }: { text: string }) {
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
  /** The prompt box and the window under it, where the cursors find what they point at */
  const root = useRef<HTMLDivElement>(null);
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
    const scope = root.current;
    if (!frame || !scope) return;
    const place = () => {
      const box = frame.getBoundingClientRect();
      const page = document.documentElement.clientWidth;
      const entering = !entered.current && !still;
      entered.current = true;
      for (const [i, who] of WHO.entries()) {
        const el = cursors.current[who];
        if (!el) continue;
        const name = step.at[who];
        const target = name ? scope.querySelector(`[data-target="${name}"]`) : null;
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

  const made = step.tool !== 'none';

  return (
    <div className="canvas-wrap" aria-hidden ref={root}>
      <PromptBox sending={sending} space="Riverside Makers">
        {step.typing ? (
          <Typed key={`${at.round}-${at.step}`} text={step.prompt} />
        ) : step.building ? (
          <Building>{step.building}</Building>
        ) : (
          step.prompt || <span className="prompt-hint">Ask your agent for anything your group needs</span>
        )}
      </PromptBox>

      <div className="window">
        <div className="window-bar">
          <span className="window-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="window-title">Minca</span>
        </div>
        <div className="canvas" ref={canvas}>
          <nav className="w-rail">
            <Mark size={26} />
            <span className="w-rail-rule" />
            <SpaceBadge letter="R" kind="clover" colour="cobalt" on />
            <SpaceBadge letter="P" kind="flower" colour="peach" />
            <SpaceBadge letter="B" kind="scallop" colour="sage" />
            <span className="w-rail-add">+</span>
          </nav>

          <aside className="w-side">
            <div className="w-space">
              <SpaceBadge letter="R" kind="clover" colour="cobalt" />
              <span>
                <b>Riverside Makers</b>
                <small>
                  <LockGlyph /> Private · 5 here
                </small>
              </span>
            </div>
            <span className="w-heading">Tools</span>
            <SideTool
              kind={TOOL_SHAPES.chat?.kind}
              colour={TOOL_SHAPES.chat?.colour}
              label="Chat"
              count={3}
            />
            <SideTool kind={TOOL_SHAPES.events?.kind} colour={TOOL_SHAPES.events?.colour} label="Events" />
            <SideTool kind={TOOL_SHAPES.polls?.kind} colour={TOOL_SHAPES.polls?.colour} label="Polls" />
            {made ? (
              <SideTool key={`made-${at.round}`} kind="clover" colour="coral" label="Hack night" on fresh />
            ) : null}
            <SideTool label="New tool" on={!made} quiet />
            <span className="w-heading">Space</span>
            <SideTool label="People" quiet />
            <SideTool label="Hosting" quiet>
              <span className="w-online" title="Online" />
            </SideTool>
          </aside>

          <main className="w-main">
            <header className="w-main-bar">
              {made ? (
                <>
                  <Shape kind="clover" colour="coral" size={18} />
                  <b>Hack night</b>
                </>
              ) : (
                <b>New tool</b>
              )}
            </header>
            <div className="canvas-stack">
              {step.tool === 'none' ? null : (
                <div className="canvas-app" key={`tool-${at.round}`}>
                  <div className="app">
                    <EventHead
                      day="Thu"
                      date="14"
                      title="Hack night"
                      meta={step.tool === 'empty' ? '7pm · no host yet' : '7pm · The Loft · Joe hosts'}
                    />
                    {step.tool === 'event' ? (
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
          </main>

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
    </div>
  );
}

/**
 * An agent's prompt box, as AI tools draw theirs: what is asked on top, and
 * under it the space it goes to, the agent picker and the send button. The
 * cursors find it and its button by `data-target`.
 */
export function PromptBox({
  sending,
  space,
  className,
  children,
}: {
  sending?: boolean;
  space?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `prompt ${className}` : 'prompt'} data-target="prompt">
      <div className="prompt-text">{children}</div>
      <div className="prompt-bar">
        <span className="prompt-add">+</span>
        {space ? (
          <span className="prompt-chip is-space">
            <Shape kind="clover" colour="cobalt" size={14} />
            {space}
          </span>
        ) : null}
        <span className="prompt-chip">
          <Shape kind="sparkle" colour="coral" size={14} />
          Claude
          <Chevron />
        </span>
        <span className={sending ? 'prompt-send pressed' : 'prompt-send'} data-target="send">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
    </div>
  );
}

/** What the agent says it is doing, beside the hopping shapes */
export function Building({ children }: { children: string }) {
  return (
    <span className="prompt-building">
      <Loader size={12} label={children} />
      {children}
    </span>
  );
}

/** The small down arrow on a picker */
function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path
        d="m2.5 4 2.5 2.5L7.5 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A space down the rail, or at the head of its sidebar: its shape with its first letter on it */
export function SpaceBadge({
  letter,
  kind,
  colour,
  on,
}: {
  letter: string;
  kind: ShapeKind;
  colour: ShapeColour;
  on?: boolean;
}) {
  return (
    <span className={on ? 'w-badge is-on' : 'w-badge'}>
      <Shape kind={kind} colour={colour} />
      <b style={{ color: colour === 'peach' || colour === 'sage' ? 'var(--ink)' : '#fff' }}>{letter}</b>
    </span>
  );
}

/** A line in the space's sidebar: a tool's shape, or a plain dot for the space's own pages */
function SideTool({
  kind,
  colour,
  label,
  count,
  on,
  fresh,
  quiet,
  children,
}: {
  kind?: ShapeKind;
  colour?: ShapeColour;
  label: string;
  count?: number;
  on?: boolean;
  fresh?: boolean;
  quiet?: boolean;
  children?: ReactNode;
}) {
  const className = ['w-item', on && 'is-on', fresh && 'is-fresh', quiet && 'is-quiet']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={className}>
      {kind ? <Shape kind={kind} colour={colour} size={16} /> : <span className="w-item-dot" />}
      <span className="w-item-label">{label}</span>
      {count ? <span className="w-count">{count}</span> : null}
      {fresh ? <span className="w-new">New</span> : null}
      {children}
    </span>
  );
}

/** A small padlock, the way the app marks a private space */
function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="1.5" y="4.5" width="7" height="5" rx="1.2" fill="currentColor" />
      <path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
