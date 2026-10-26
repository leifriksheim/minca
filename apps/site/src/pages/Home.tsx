import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { APP, Band, ChromeMark, DownloadMark, EXTERNAL, Marked, Page, Points } from './Site';
import { HeroSpace } from './HeroSpace';
import { Loader } from '@minca/app-shared/Loader';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { Morph, Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Carpool, SchoolRun, type CarpoolChange } from './demos';
import { usePlatform } from './downloads';
import { downloadLink } from './Install';

/**
 * The front page, for community builders who are tired of billionaires
 * owning every place we meet. A minca (minka) is the Andean custom of
 * everyone turning out to build what serves them all. The page's argument:
 * our social spaces are infrastructure, like water and power, yet a few
 * companies own them, rebuild the same app in silos and take a cut of
 * everything. Software is nearly free to make now, so groups can build on
 * shared ground instead, and every group that improves a tool improves it
 * for the next.
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

/**
 * The big platforms, drawn as a badge in their own colour with their name on
 * it (`.brand-*` in site.css), not their logo files
 */
type Brand = 'uber' | 'bolt' | 'lyft' | 'lime' | 'voi' | 'vinted' | 'ticketmaster' | 'meta';
const BRAND_NAMES: Readonly<Record<Brand, string>> = {
  uber: 'Uber',
  bolt: 'Bolt',
  lyft: 'Lyft',
  lime: 'Lime',
  voi: 'Voi',
  vinted: 'Vinted',
  ticketmaster: 'Ticketmaster',
  meta: 'Meta',
};

function BrandBadge({ brand }: { brand: Brand }) {
  return (
    <span className={`brand-badge brand-${brand}`} aria-hidden>
      {BRAND_NAMES[brand][0]}
    </span>
  );
}

/** A week of ordinary things, and what the platforms in the middle kept */
const RECEIPT: ReadonlyArray<{ brand: Brand; what: string; cut: string }> = [
  { brand: 'uber', what: 'Lift home from the match', cut: '€3.20' },
  { brand: 'vinted', what: 'A jacket from down the street', cut: '€1.95' },
  { brand: 'ticketmaster', what: 'Two tickets to a gig', cut: '€14.50' },
  { brand: 'meta', what: 'Your club’s Facebook group', cut: 'Your attention' },
];

function Receipt() {
  return (
    <div className="receipt">
      <div className="receipt-head">
        <b>Your week online</b>
        <span>Their cut</span>
      </div>
      {RECEIPT.map((line) => (
        <div key={line.what} className="receipt-line">
          <span className="receipt-what">
            <BrandBadge brand={line.brand} />
            <span>
              {line.what}
              <small>{BRAND_NAMES[line.brand]}</small>
            </span>
          </span>
          <span>{line.cut}</span>
        </div>
      ))}
      <div className="receipt-total">
        <span>Paid to oligarchs</span>
        <b>€19.65</b>
      </div>
    </div>
  );
}

/** Five ride apps: the same map under each, only the name and the colour change */
const RIDE_APPS: readonly Brand[] = ['uber', 'bolt', 'lyft', 'lime', 'voi'];

/** The map every ride app draws: blocks, a route, you and a car */
function RideMap() {
  return (
    <svg className="ride-map" viewBox="0 0 100 110" aria-hidden>
      {[
        [8, 8, 34, 22],
        [52, 8, 40, 30],
        [8, 40, 26, 30],
        [44, 48, 48, 18],
        [8, 80, 50, 22],
        [68, 76, 24, 26],
      ].map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="4" />
      ))}
      <path className="ride-route" d="M24 100V74H40V42H90" />
      <circle className="ride-you" cx="24" cy="100" r="4.5" />
      <rect className="ride-car" x="84" y="37" width="12" height="10" rx="3" />
    </svg>
  );
}

function SameApp() {
  return (
    <div className="same-app">
      {RIDE_APPS.map((brand) => (
        <div key={brand} className={`ride-phone brand-${brand}`}>
          <div className="ride-brand">
            <BrandBadge brand={brand} />
            {BRAND_NAMES[brand]}
          </div>
          <RideMap />
          <div className="ride-book">
            <span>Ride now</span>
            <small>+ service fee</small>
          </div>
        </div>
      ))}
    </div>
  );
}

/** What a group's space gives it, whoever made its tools */
const YOURS: ReadonlyArray<{ title: string; body: string; shape: ShapeKind }> = [
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
];

/** Five companies each build the app from nothing; five groups build on the one before */
const COMPANY_BUILDS = RIDE_APPS.map((brand) => BRAND_NAMES[brand]);
const GROUP_BUILDS: ReadonlyArray<{ group: string; adds: string }> = [
  { group: 'Riverside FC', adds: 'Carpool' },
  { group: 'Northside', adds: '+ Waitlist' },
  { group: 'Oak Primary', adds: '+ School run' },
  { group: 'Elm Street', adds: '+ Lifts home' },
  { group: 'Hill Road', adds: '+ Reminders' },
];

function Compounds() {
  return (
    <div className="compounds">
      <div className="frame compound">
        <h3>Five companies</h3>
        <div className="compound-cols">
          {COMPANY_BUILDS.map((name) => (
            <div key={name} className="compound-col">
              <span className="compound-block is-same">Ride app</span>
              <small>{name}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="frame compound">
        <h3>Five groups on Minca</h3>
        <div className="compound-cols">
          {GROUP_BUILDS.map((build, i) => (
            <div key={build.group} className="compound-col">
              {GROUP_BUILDS.slice(0, i + 1)
                .reverse()
                .map((step, j) => (
                  <span key={step.adds} className={`compound-block ${colour(i - j)}`}>
                    {step.adds}
                  </span>
                ))}
              <small>{build.group}</small>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  { ask: 'Who needs groceries this week?', tool: 'Mutual aid', kind: 'burst', colour: 'lilac' },
  {
    ask: 'A sign-up sheet for the potluck. Joe says he’s bringing the rich.',
    tool: 'Potluck',
    kind: 'flower',
    colour: 'cobalt',
  },
];

/** The big shape in the panel, melting from one to the next */
const ANYTHING = [
  { kind: 'flower', colour: 'peach' },
  { kind: 'squircle', colour: 'coral' },
  { kind: 'burst', colour: 'lilac' },
  { kind: 'clover', colour: 'cobalt' },
  { kind: 'star', colour: 'peach' },
  { kind: 'scallop', colour: 'coral' },
  { kind: 'sparkle', colour: 'lilac' },
] as const;

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
        <a href="#why" className="btn btn-secondary btn-lg">
          Why this matters
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
            <DownloadMark />
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
            One place for your club, your street or your crew to talk, plan and build any app you need. And it
            belongs to all of you.
          </p>
          <HeroActions />
        </div>
        <div className="wrap">
          <HeroSpace />
        </div>
      </section>

      <Band
        id="why"
        tone="sunken"
        title="The same app, built a hundred times."
        intro={
          <p>
            Uber, Bolt, Lyft, Lime and Voi each built a map, a way to pay and a ride nearby, then walled it
            off. That’s like every town laying five water mains so five billionaires can bill you for a glass.
            Now AI can build the app in an afternoon, and the walls are only there to collect the toll.
          </p>
        }
      >
        <SameApp />
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="tile tile-panel panel c-cobalt">
            <Morph steps={ANYTHING} className="panel-morph" />
            <div className="section-head">
              <h2>If you can say it, you can have it.</h2>
              <p>Tell Claude, ChatGPT or any AI what your group needs, and it’s there by tonight.</p>
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
        id="mend"
        tone="sunken"
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
                <li>Everyone’s vote counts the same, however much they put in the kitty</li>
                <li>Pick how many yeses it takes</li>
                <li>A tool only sees its own things, never your chats</li>
              </ul>
            </div>
            <div className="frame paper-grid">{PROPOSAL}</div>
          </div>
        </div>
      </section>

      <Band
        tone="sunken"
        title="Good ideas spread."
        intro={
          <p>
            Riverside FC makes a carpool. A hockey club copies it and adds a waitlist. A school turns it into
            a school run. Nobody asked permission and nobody took a cut.
          </p>
        }
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

      <Band
        title="Nobody has to start from scratch."
        intro={
          <p>
            Every company builds the same thing again from nothing. When a group on Minca makes a tool better,
            every group after them gets the better one.
          </p>
        }
      >
        <Compounds />
      </Band>

      <section className="band sunken">
        <div className="wrap">
          <div className="split">
            <div>
              <h2 className="split-title">Digital landlords own our spaces.</h2>
              <p>
                Your group chat, your local marketplace and your ride home all sit on someone else’s property.
                They make the rules, take a cut of every lift and every sale, and book the profit wherever the
                tax is lowest. It’s feudalism with an app store.
              </p>
            </div>
            <div className="frame paper-grid">
              <Receipt />
            </div>
          </div>
        </div>
      </section>

      <Band
        title="Some things should belong to everyone."
        intro={
          <p>Minca is an open protocol, a shared set of rules anyone can build on and nobody can buy.</p>
        }
      >
        <Marked items={YOURS} />
      </Band>

      <Band
        id="minca"
        tone="sunken"
        title="In the Andes, nobody waits for someone else to build the bridge."
        intro={
          <>
            <p>
              Minca comes from <i>minka</i> (say “MEEN-ka”), the Quechua word for work done together. Quechua
              and Aymara communities have practised it for centuries. When something would help everyone,
              everyone turns up and builds it.
            </p>
            <p>
              Every June, four Quechua communities in Peru still reweave the Q’eswachaka rope bridge by hand,
              the way they have for over 500 years.
            </p>
          </>
        }
      />

      <Band title="Fair questions.">
        <Points
          points={[
            { title: 'Who owns it?', body: 'Nobody, the same way nobody owns a language.' },
            {
              title: 'Can I build a business on it?',
              body: 'Sure, the way people build businesses on roads. You just can’t own the road.',
            },
            { title: 'Do I need to code?', body: 'No. If you can describe it, you can make it.' },
            {
              title: 'Is it ready?',
              body: 'It works and it’s early. Start with a group that’s up for an adventure.',
            },
          ]}
        />
      </Band>

      <section className="cta">
        <div className="wrap">
          <div className="cta-panel">
            <Loader decorative size={34} style={{ marginBottom: 28 }} />
            <h2>Call your people.</h2>
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
