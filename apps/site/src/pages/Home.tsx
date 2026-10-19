import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { APP, Band, ChromeMark, EXTERNAL, Page, Points } from './Site';
import { HeroSpace } from './HeroSpace';
import { Loader } from '@minca/app-shared/Loader';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { Morph, Shape, type ShapeKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';
import { Carpool, SchoolRun, type CarpoolChange } from './demos';
import { usePlatform } from './downloads';
import { downloadLink } from './Install';

/**
 * The front page, for community builders: it sells the Minca app. A minca
 * (minka) is the Andean custom of everyone turning out to build what serves
 * them all. The page's argument: making software is nearly free now, so a
 * group can have whatever it imagines, change it whenever it likes, and pass
 * it on to the next group.
 *
 * It shows rather than tells: each band is the product doing one thing, drawn
 * as the app draws it (`demos.tsx`). The brand draws a space as a ruled grid
 * and every tool as a shape in it (`shapes.tsx`).
 */

/** The palette, one class per colour; shapes take turns with them */
const COLOURS = ['cobalt', 'coral', 'peach', 'sage', 'lilac'] as const;
const colour = (i: number) => `c-${COLOURS[i % COLOURS.length]}`;

/** What a group asks to change about its carpool, and what stays as it was */
const CHANGES: ReadonlyArray<{ id: CarpoolChange; ask: string; who: string }> = [
  { id: 'waitlist', ask: 'Add a waitlist for when the cars are full', who: 'Maya' },
  { id: 'home', ask: 'Let people sort out lifts home too', who: 'Joe' },
  { id: 'reminder', ask: 'Remind drivers the night before', who: 'Anna' },
];

/** A shape beside each change asked for */
const ASK_SHAPES: readonly ShapeKind[] = ['flower', 'burst', 'scallop'];

/** One change asked for, shown as it was and as it is, in turn; a visitor's click stops the turning */
function Mend() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [at, setAt] = useState({ change: 0, now: true });
  const [playing, setPlaying] = useState(!still);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(
      () =>
        setAt(({ change, now }) =>
          now ? { change: (change + 1) % CHANGES.length, now: false } : { change, now: true },
        ),
      at.now ? 3600 : 1400,
    );
    return () => clearTimeout(timer);
  }, [at, playing]);

  const pick = (next: { change: number; now: boolean }) => {
    setPlaying(false);
    setAt(next);
  };
  const change = CHANGES[at.change] ?? CHANGES[0]!;

  return (
    <div className="mend">
      <div className="mend-asks" role="group" aria-label="Changes people asked for">
        {CHANGES.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className="mend-ask"
            aria-pressed={i === at.change}
            onClick={() => pick({ change: i, now: true })}
          >
            <Shape kind={ASK_SHAPES[i] ?? 'scallop'} className={colour(i + 1)} />
            <span>
              “{c.ask}”<small>{c.who}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="mend-view">
        <div className="frame-head">
          <span className="frame-title">
            <Shape kind="clover" colour="coral" />
            <b>Carpool</b>
          </span>
          <div className="toggle" role="group" aria-label="Before or after">
            <button type="button" aria-pressed={!at.now} onClick={() => pick({ ...at, now: false })}>
              Was
            </button>
            <button type="button" aria-pressed={at.now} onClick={() => pick({ ...at, now: true })}>
              Now
            </button>
          </div>
        </div>
        <div className="frame-body" key={`${at.change}-${at.now}`}>
          <Carpool change={at.now ? change.id : undefined} />
        </div>
        <div className="frame-foot">
          <span>Stays as it was</span>
          {['Who’s in the group', 'Your chats', 'Who can change a ride'].map((kept) => (
            <span key={kept} className="kept">
              {kept}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The same change, as a proposal the group decides on, drawn after the Decisions app */
const PROPOSAL = (
  <div className="proposal">
    <div className="proposal-head">
      <b>Carpool, with a waitlist</b>
      <span className="tag good">Decided</span>
    </div>
    <div className="by">From Maya · 5 yeses decide it</div>
    <ul>
      <li>Anyone can join the waitlist for a full ride</li>
      <li>The first in line gets a seat that opens</li>
      <li>Still: only the driver changes their ride</li>
    </ul>
    <div className="tally">
      {[
        { option: 'Yes', votes: 5, won: true },
        { option: 'No', votes: 1, won: false },
      ].map((row) => (
        <div key={row.option} className={row.won ? 'tally-row won' : 'tally-row'}>
          <span className="tally-bar" style={{ width: `${(row.votes / 5) * 100}%` }} />
          <span className="tally-option">
            {row.option}
            {row.won ? ' ✓' : ''}
          </span>
          <span className="tally-count">{row.votes} of 5</span>
        </div>
      ))}
    </div>
  </div>
);

/** One tool travelling between groups, each making it theirs */
const REMIXES: ReadonlyArray<{ group: string; change: string; app: ReactNode }> = [
  { group: 'Riverside FC', change: 'Makes a carpool for away games', app: <Carpool /> },
  {
    group: 'Northside Hockey',
    change: 'Takes it, and adds a waitlist',
    app: <Carpool change="waitlist" trip="Sunday · away at Eastfield" />,
  },
  { group: 'Oak Primary parents', change: 'Turns it into a school run', app: <SchoolRun /> },
];

/** What groups asked for, in their own words, and the tool each became */
const ASKS: ReadonlyArray<{ ask: string; tool: string; kind: ShapeKind; colour: ShapeColour }> = [
  { ask: 'Can we sort out lifts to away games?', tool: 'Carpool', kind: 'clover', colour: 'coral' },
  {
    ask: 'Could we share tools instead of all buying drills?',
    tool: 'Tool library',
    kind: 'squircle',
    colour: 'sage',
  },
  {
    ask: 'One list of everything the landlord hasn’t fixed.',
    tool: 'Repairs',
    kind: 'star',
    colour: 'peach',
  },
  { ask: 'Whose turn is it to do the bins?', tool: 'Chore wheel', kind: 'burst', colour: 'lilac' },
];

/** The big shape in the panel, melting from one to the next */
const ANYTHING = [
  { kind: 'flower', colour: 'peach' },
  { kind: 'squircle', colour: 'coral' },
  { kind: 'burst', colour: 'lilac' },
  { kind: 'clover', colour: 'paper' },
  { kind: 'star', colour: 'peach' },
  { kind: 'scallop', colour: 'coral' },
  { kind: 'sparkle', colour: 'lilac' },
] as const;

/** Short points side by side, each marked with the shape that stands for it */
function Marked({ items }: { items: ReadonlyArray<{ title: string; body: string; shape: ShapeKind }> }) {
  return (
    <div className="ruled marked">
      {items.map((item, i) => (
        <div key={item.title}>
          <Shape kind={item.shape} className={colour(i)} />
          <h3>{item.title}</h3>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

/** The mark's canvas, cropped to the bands so they stand on the panel's bottom edge */
const RAINBOW_VIEWBOX = '0.5 1 23 11.5';

/** The mark's rainbow, large, rising from the bottom of a panel */
function Rainbow() {
  return (
    <svg className="rainbow" viewBox={RAINBOW_VIEWBOX} aria-hidden>
      {MARK_BANDS.map((band) => (
        <path key={band.d} d={band.d} fill={band.fill} />
      ))}
    </svg>
  );
}

/**
 * The hero's buttons: the desktop app for the computer the visitor is on, and
 * the browser beside it. A download lands on /install, which says how to open
 * an app that isn't signed yet. A phone gets the app in the browser.
 */
function HeroActions() {
  const platform = usePlatform();
  if (platform === 'mobile') {
    return (
      <div className="actions">
        <a href={APP} className="btn btn-primary btn-lg">
          Start a minca
        </a>
        <a href="#mend" className="btn btn-secondary btn-lg">
          See what it does
        </a>
      </div>
    );
  }
  const desktop = platform === 'mac' || platform === 'windows' ? platform : null;
  return (
    <>
      <div className="actions">
        {desktop ? (
          <Link {...downloadLink(desktop)} className="btn btn-primary btn-lg">
            {desktop === 'mac' ? 'Download for Mac' : 'Download for Windows'}
          </Link>
        ) : null}
        <a href={APP} {...EXTERNAL} className={`btn btn-lg ${desktop ? 'btn-secondary' : 'btn-primary'}`}>
          Open Minca in your browser
        </a>
      </div>
      <Link {...downloadLink('chrome')} className="hero-aside">
        <ChromeMark />
        Get the Chrome extension
      </Link>
    </>
  );
}

export function Home() {
  return (
    <Page page="home">
      <section className="hero home-hero">
        <div className="wrap">
          <h1>
            Many hands
            <br />
            make it happen.
          </h1>
          <p>
            One place for your club, your street or your crew to talk, plan and get things done. Need
            something that doesn’t exist yet? Ask for it, and it’s yours.
          </p>
          <HeroActions />
        </div>
        <div className="wrap">
          <HeroSpace />
        </div>
      </section>

      <Band
        id="mend"
        title="Change anything. Just say how."
        intro={
          <p>
            Every tool in your space can be mended by anyone with an idea. Say what’s missing, and the new
            version arrives just like the first one did.
          </p>
        }
      >
        <Mend />
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h2 className="split-title">Nothing changes until your group says yes.</h2>
              <p>
                A new tool, or a new version of one, says in plain words what it can do. The people your group
                trusts add it, or everyone votes.
              </p>
              <ul>
                <li>Pick how many yeses it takes</li>
                <li>A tool only sees its own things, never your chats</li>
                <li>Nobody has to count, and nobody can fake it</li>
              </ul>
            </div>
            <div className="frame paper-grid">{PROPOSAL}</div>
          </div>
        </div>
      </section>

      <Band
        tone="sunken"
        title="Good ideas spread."
        intro={<p>Made something great? Pass it to another group. They make it theirs, and pass it on.</p>}
      >
        <div className="ruled remixes">
          {REMIXES.map((remix, i) => (
            <div key={remix.group} className="remix">
              <span className="cell-num">v{i + 1}</span>
              <b className="remix-group">{remix.group}</b>
              <p>{remix.change}</p>
              <div className="remix-app">{remix.app}</div>
            </div>
          ))}
        </div>
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="panel">
            <Morph steps={ANYTHING} className="panel-morph" />
            <div className="section-head">
              <h2>If you can say it, you can have it.</h2>
              <p>
                Building an app used to take money and experts. Now you tell Claude, ChatGPT or any AI what
                your group needs, and it’s there by tonight. No code, no servers, no bills.
              </p>
            </div>
            <ul className="asks">
              {ASKS.map((item) => (
                <li key={item.tool}>
                  <q>{item.ask}</q>
                  <span className="asks-tool">
                    <Shape kind={item.kind} colour={item.colour} />
                    {item.tool}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <Band
        id="minca"
        tone="sunken"
        title="In the Andes, nobody waits for someone else to build the bridge."
        intro={
          <p>
            They call it a minca: when something would help everyone, everyone shows up and builds it. Minca
            gives your club, your street and your crew a place to do the same, and it’s yours, not a
            platform’s.
          </p>
        }
      >
        <Marked
          items={[
            {
              title: 'No ads, no feed',
              body: 'Nobody’s watching, and nothing decides what you see.',
              shape: 'eyeShut',
            },
            { title: 'Your rules', body: 'Your group decides who can do what.', shape: 'group' },
            {
              title: 'Private',
              body: 'Private spaces are locked on your phone before anything leaves it.',
              shape: 'lock',
            },
            { title: 'Works offline', body: 'On the bus, in the field, in the basement.', shape: 'signal' },
          ]}
        />
      </Band>

      <Band title="Fair questions.">
        <Points
          points={[
            { title: 'Do I need to code?', body: 'No. If you can describe it, you can make it.' },
            {
              title: 'Does everyone need an AI?',
              body: 'No. Only whoever makes something new. Everyone else just opens the link.',
            },
            {
              title: 'Is it ready?',
              body: 'It’s early days. It works, and it’s still changing. Start with a group that’s up for an adventure.',
            },
            { title: 'Who owns it?', body: 'Your group. There’s no company in the middle.' },
          ]}
        />
      </Band>

      <section className="cta">
        <div className="wrap">
          <div className="cta-panel">
            <Loader decorative size={34} style={{ marginBottom: 28 }} />
            <h2>Call your people.</h2>
            <p>Start a minca and make it yours.</p>
            <div className="actions">
              <a href={APP} className="btn btn-primary btn-lg">
                Start a minca
              </a>
            </div>
            <Link to="/developers" className="aside-link">
              Building apps? Minca is an open protocol too →
            </Link>
            <Rainbow />
          </div>
        </div>
      </section>
    </Page>
  );
}
