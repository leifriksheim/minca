import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { APP, Band, ChromeMark, DownloadMark, EXTERNAL, Marked, Page, Points, Tabs } from './Site';
import { HeroSpace } from './HeroSpace';
import { Loader } from '@minca/app-shared/Loader';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { Morph, Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Meetup, OpenMic, type MeetupChange } from './demos';
import { usePlatform } from './downloads';
import { downloadLink } from './Install';
import { LOGOS } from './logos';

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

/** What a group asks to change about its meetup, and what stays as it was */
const CHANGES: ReadonlyArray<{ id: MeetupChange; ask: string; who: string }> = [
  { id: 'waitlist', ask: 'Add a waitlist for when it’s full', who: 'Maya' },
  { id: 'talks', ask: 'Let people sign up for a lightning talk', who: 'Joe' },
  { id: 'reminder', ask: 'Remind everyone the day before', who: 'Anna' },
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
            <b>Hack night</b>
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
          <Meetup change={at.now ? change.id : undefined} />
        </div>
        <div className="frame-foot">
          <span>Stays as it was</span>
          {['Who’s in the group', 'Your chats', 'Who can change the event'].map((kept) => (
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
      <b>Hack night, with a waitlist</b>
      <span className="tag good">Decided</span>
    </div>
    <div className="by">From Maya · 5 yeses decide it</div>
    <ul>
      <li>Anyone can join the waitlist when it’s full</li>
      <li>The first in line gets a spot that opens</li>
      <li>Only the host can change the event</li>
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
  { group: 'Riverside Makers', change: 'Makes an RSVP for hack night', app: <Meetup /> },
  {
    group: 'Pixel Pals Discord',
    change: 'Takes it, and adds a waitlist',
    app: <Meetup change="waitlist" title="Game night" day="Fri" date="15" where="9pm · voice channel" />,
  },
  { group: 'Northside Open Mic', change: 'Turns it into slots for acts', app: <OpenMic /> },
];

/**
 * The big platforms, drawn as their logo in white on a badge of their colour
 * (`.brand-*` in site.css); one without a logo in `logos.ts` gets its initial
 */
type Brand =
  | 'uber'
  | 'lyft'
  | 'grab'
  | 'vinted'
  | 'ticketmaster'
  | 'meta'
  | 'airbnb'
  | 'booking'
  | 'expedia'
  | 'slack'
  | 'discord'
  | 'googlechat'
  | 'instagram'
  | 'tiktok'
  | 'x';
const BRAND_NAMES: Readonly<Record<Brand, string>> = {
  uber: 'Uber',
  lyft: 'Lyft',
  grab: 'Grab',
  vinted: 'Vinted',
  ticketmaster: 'Ticketmaster',
  meta: 'Meta',
  airbnb: 'Airbnb',
  booking: 'Booking',
  expedia: 'Expedia',
  slack: 'Slack',
  discord: 'Discord',
  googlechat: 'Google Chat',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
};

function BrandBadge({ brand }: { brand: Brand }) {
  const logo = LOGOS[brand];
  return (
    <span className={`brand-badge brand-${brand}`} aria-hidden>
      {logo ? (
        <svg viewBox="0 0 24 24">
          <path d={logo} />
        </svg>
      ) : (
        BRAND_NAMES[brand][0]
      )}
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

/** One feature of an app, outlined on its screen by boxes in the screen's units; none means the button */
type Feature = {
  name: string;
  colour: ShapeColour;
  boxes?: ReadonlyArray<readonly [number, number, number, number]>;
};

/** Every feature keeps one colour wherever it turns up, so the same piece reads the same in each app */
const FEATURE_COLOURS: Readonly<Record<string, ShapeColour>> = {
  Photos: 'sage',
  Listings: 'cobalt',
  Saved: 'coral',
  Reviews: 'peach',
  Payments: 'lilac',
  Map: 'sage',
  'Live location': 'coral',
  Rooms: 'cobalt',
  Messages: 'peach',
  Profiles: 'coral',
  Posts: 'sage',
  Likes: 'peach',
  Comments: 'cobalt',
  Ads: 'lilac',
};

const feature = (name: string, boxes?: Feature['boxes']): Feature => ({
  name,
  colour: FEATURE_COLOURS[name] ?? 'cobalt',
  boxes,
});

/** Three apps of a kind, and the features any one of them is made of */
const KINDS: ReadonlyArray<{
  id: string;
  name: string;
  shape: { kind: ShapeKind; colour: ShapeColour };
  kind: string;
  brands: readonly [Brand, Brand, Brand];
  button: string;
  fee: string;
  screen: ReactNode;
  features: readonly Feature[];
}> = [
  {
    id: 'stays',
    name: 'Stays',
    shape: { kind: 'arch', colour: 'coral' },
    kind: 'stay',
    brands: ['airbnb', 'booking', 'expedia'],
    button: 'Reserve',
    fee: '+ service fee',
    screen: (
      <>
        <rect className="screen-block" x="8" y="8" width="84" height="56" rx="6" />
        <path className="screen-accent" d="M8 52l22-18 16 12 14-10 32 22v6a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" />
        <circle className="screen-accent" cx="62" cy="24" r="7" />
        <circle className="screen-block" cx="83" cy="17" r="5" />
        <text className="screen-text" x="80.4" y="19.4">
          ♥
        </text>
        <rect className="screen-line" x="8" y="72" width="58" height="7" rx="3.5" />
        <text className="screen-text" x="8" y="94">
          ★ 4.9 · 212 reviews
        </text>
      </>
    ),
    features: [
      feature('Photos', [[5, 5, 90, 62]]),
      feature('Saved', [[75, 9, 16, 16]]),
      feature('Listings', [[5, 69, 64, 13]]),
      feature('Reviews', [[5, 86, 74, 12]]),
      feature('Payments'),
    ],
  },
  {
    id: 'rides',
    name: 'Rides',
    shape: { kind: 'clover', colour: 'cobalt' },
    kind: 'ride',
    brands: ['uber', 'lyft', 'grab'],
    button: 'Ride now',
    fee: '+ service fee',
    screen: (
      <>
        {[
          [8, 8, 34, 22],
          [52, 8, 40, 30],
          [8, 40, 26, 26],
          [44, 48, 48, 18],
        ].map(([x, y, w, h]) => (
          <rect key={`${x}-${y}`} className="screen-block" x={x} y={y} width={w} height={h} rx="4" />
        ))}
        <path className="screen-route" d="M24 74V36H40V42H86" />
        <circle className="screen-you" cx="24" cy="74" r="4.5" />
        <rect className="screen-accent" x="80" y="37" width="12" height="10" rx="3" />
        <rect className="screen-block" x="8" y="84" width="84" height="18" rx="6" />
        <text className="screen-text" x="13" y="95.5">
          Ali · ★ 4.8 · 3 min away
        </text>
      </>
    ),
    features: [
      feature('Map', [[5, 5, 90, 64]]),
      feature('Live location', [
        [17, 67, 14, 14],
        [76, 33, 20, 18],
      ]),
      feature('Reviews', [[5, 81, 90, 24]]),
      feature('Payments'),
    ],
  },
  {
    id: 'chat',
    name: 'Chat',
    shape: { kind: 'scallop', colour: 'peach' },
    kind: 'chat',
    brands: ['slack', 'discord', 'googlechat'],
    button: 'Upgrade',
    fee: '€8 a seat',
    screen: (
      <>
        {['general', 'random', 'help'].map((room, i) => (
          <g key={room}>
            <rect
              className={i === 0 ? 'screen-accent' : 'screen-block'}
              x="8"
              y={8 + i * 13}
              width="84"
              height="10"
              rx="4"
            />
            <text className={i === 0 ? 'screen-text is-on' : 'screen-text'} x="13" y={15 + i * 13}>
              # {room}
            </text>
          </g>
        ))}
        {[
          [56, 52],
          [74, 40],
          [92, 58],
        ].map(([y, w]) => (
          <g key={y}>
            <circle className="screen-you" cx="13" cy={(y ?? 0) + 6} r="5" />
            <rect className="screen-block" x="22" y={y} width={w} height="12" rx="6" />
          </g>
        ))}
      </>
    ),
    features: [
      feature('Rooms', [[5, 5, 90, 42]]),
      feature('Messages', [[19, 52, 76, 54]]),
      feature('Profiles', [[6, 52, 14, 54]]),
      feature('Payments'),
    ],
  },
  {
    id: 'feeds',
    name: 'Feeds',
    shape: { kind: 'star', colour: 'lilac' },
    kind: 'feed',
    brands: ['instagram', 'tiktok', 'x'],
    button: 'Follow',
    fee: '+ ads',
    screen: (
      <>
        <circle className="screen-you" cx="14" cy="14" r="6" />
        <rect className="screen-line" x="24" y="11" width="40" height="6" rx="3" />
        <rect className="screen-block" x="8" y="25" width="84" height="52" rx="6" />
        <path className="screen-accent" d="M8 65l26-20 18 12 16-10 24 16v8a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" />
        <text className="screen-text" x="8" y="90">
          ♥ 1.2k · 💬 48
        </text>
        <rect className="screen-line" x="8" y="96" width="70" height="6" rx="3" />
      </>
    ),
    features: [
      feature('Profiles', [[5, 5, 64, 18]]),
      feature('Posts', [[5, 22, 90, 58]]),
      feature('Likes', [[5, 82, 56, 11]]),
      feature('Comments', [[5, 94, 76, 10]]),
      feature('Ads'),
    ],
  },
];

/** How long each step holds: three phones, sliding together, one phone, each feature, then the whole picture */
const APART_MS = 1100;
const SLIDE_MS = 800;
const MERGED_MS = 700;
const FEATURE_MS = 950;
const HOLD_MS = 2600;

/** The step a kind ends on, every feature named */
const lastStep = (i: number) => (KINDS[i]?.features.length ?? 0) + 3;

/**
 * Three apps of a kind side by side, slid together into one, then taken
 * apart feature by feature; then the next kind. Picking a kind starts it there.
 */
function SameApp() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [at, setAt] = useState({ kind: 0, step: still ? lastStep(0) : 0 });
  const kind = KINDS[at.kind] ?? KINDS[0]!;
  const done = lastStep(at.kind);

  useEffect(() => {
    if (still) return;
    const { step } = at;
    const wait =
      step === 0
        ? APART_MS
        : step === 1
          ? SLIDE_MS
          : step === 2
            ? MERGED_MS
            : step >= done
              ? HOLD_MS
              : FEATURE_MS;
    const timer = setTimeout(
      () =>
        setAt(
          step < done ? { kind: at.kind, step: step + 1 } : { kind: (at.kind + 1) % KINDS.length, step: 0 },
        ),
      wait,
    );
    return () => clearTimeout(timer);
  }, [at, done, still]);

  const sliding = at.step >= 1;
  const merged = at.step >= 2;
  const lit = at.step - 3;
  const button = kind.features.find((f) => !f.boxes);

  const chip = (f: Feature) => {
    const i = kind.features.indexOf(f);
    return (
      <span
        key={f.name}
        className={`feature-chip c-${f.colour}`}
        data-on={i <= lit || undefined}
        data-now={i === lit || undefined}
      >
        <span className="feature-dot" />
        {f.name}
      </span>
    );
  };

  return (
    <div className="frame same-app">
      <Tabs
        label="Kinds of app"
        items={KINDS}
        selected={kind.id}
        onSelect={(id) => {
          const i = KINDS.findIndex((each) => each.id === id);
          setAt({ kind: i, step: still ? lastStep(i) : 0 });
        }}
      >
        {() => (
          <div className="same-stage paper-grid" data-sliding={sliding || undefined} key={kind.id}>
            <div className="feature-list is-left">
              {kind.features.filter((_, i) => i % 2 === 0).map(chip)}
            </div>
            {kind.brands.map((brand, i) => {
              const generic = i === 1 && merged;
              return (
                <div
                  key={brand}
                  className={generic ? 'app-phone is-merged' : `app-phone brand-${brand}`}
                  style={{ animationDelay: `${i * 120}ms` }}
                >
                  <div className="app-phone-name">
                    {generic ? (
                      <span className="app-phone-logos">
                        {kind.brands.map((b) => (
                          <BrandBadge key={b} brand={b} />
                        ))}
                      </span>
                    ) : (
                      <BrandBadge brand={brand} />
                    )}
                    <span>{generic ? `Any ${kind.kind} app` : BRAND_NAMES[brand]}</span>
                  </div>
                  <svg className="app-screen" viewBox="0 0 100 110" aria-hidden>
                    {kind.screen}
                    {i === 1
                      ? kind.features[lit]?.boxes?.map(([x, y, w, h]) => (
                          <rect
                            key={`${lit}-${x}-${y}`}
                            className={`screen-ring c-${kind.features[lit]?.colour}`}
                            x={x}
                            y={y}
                            width={w}
                            height={h}
                            rx="6"
                          />
                        ))
                      : null}
                  </svg>
                  <div
                    className={
                      i === 1 && button && kind.features.indexOf(button) === lit
                        ? `app-phone-button is-lit c-${button.colour}`
                        : 'app-phone-button'
                    }
                  >
                    <span>{kind.button}</span>
                    <small>{kind.fee}</small>
                  </div>
                </div>
              );
            })}
            <div className="feature-list is-right">
              {kind.features.filter((_, i) => i % 2 === 1).map(chip)}
            </div>
          </div>
        )}
      </Tabs>
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
const COMPANY_BUILDS = ['Meetup', 'Eventbrite', 'Luma', 'Partiful', 'Facebook'];
const GROUP_BUILDS: ReadonlyArray<{ group: string; adds: string }> = [
  { group: 'Riverside Makers', adds: 'RSVP' },
  { group: 'Pixel Pals', adds: '+ Waitlist' },
  { group: 'Open Mic', adds: '+ Slots' },
  { group: 'Elm Street', adds: '+ Talks' },
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
              <span className="compound-block is-same">Events app</span>
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
  { ask: 'Who’s coming to hack night on Thursday?', tool: 'RSVP', kind: 'clover', colour: 'coral' },
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
            Talk, plan and build together in a space your community owns. No oligarchs at the door, no ads on
            the walls.
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
        title="Let’s stop building the same thing."
        intro={
          <p>
            The world doesn’t need another company rebuilding the same app so people can do things together.
            Software costs next to nothing now. On Minca you make what you need, share it, and let the next
            group make it better.
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
        intro={<p>Anyone in the group can change a tool. Say what’s missing and it’s there.</p>}
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
            Riverside Makers make an RSVP for hack night. A Discord gaming group copies it and adds a
            waitlist. An open mic turns it into slots for acts. Nobody asked permission and nobody took a cut.
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
        intro={<p>When a group on Minca makes a tool better, every group after them gets the better one.</p>}
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
