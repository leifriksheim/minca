import { useState } from 'react';
import { Band, Page, Points } from './Site';
import { HeroSpace } from './HeroSpace';
import { Morph, Shape, shapeFor, type ShapeKind } from '@minca/app-shared/shapes';

/**
 * The front page, for community builders: it sells the Minca app. A minca
 * (minka) is the Andean custom of everyone turning out to build what serves
 * them all. The page's argument: making software is nearly free now, so a
 * group can have whatever it imagines, and pass it on to the next group.
 *
 * The brand draws a space as a ruled grid and every tool as a shape in it
 * (`shapes.tsx`); the hero's last cell keeps melting into a new one.
 */

/** The palette, one class per colour; shapes take turns with them */
const COLOURS = ['cobalt', 'coral', 'peach', 'sage', 'lilac'] as const;
const colour = (i: number) => `c-${COLOURS[i % COLOURS.length]}`;

/** What a space has from the moment a group starts, each with the shape it has in the app */
const BUILT_IN: ReadonlyArray<{ name: string; id: string }> = [
  { name: 'Chat', id: 'chat' },
  { name: 'Polls', id: 'polls' },
  { name: 'Decisions', id: 'decisions' },
  { name: 'Events', id: 'events' },
  { name: 'Board', id: 'kanban' },
  { name: 'Market', id: 'marketplace' },
  { name: 'Calls', id: 'calls' },
];

/** What the hero's last cell becomes, one after another */
const MADE = [
  { name: 'Carpool', kind: 'clover', colour: 'coral' },
  { name: 'Seed swap', kind: 'flower', colour: 'sage' },
  { name: 'Repair tracker', kind: 'burst', colour: 'peach' },
  { name: 'Chore wheel', kind: 'scallop', colour: 'lilac' },
  { name: 'Book club', kind: 'star', colour: 'cobalt' },
  { name: 'Choir parts', kind: 'sparkle', colour: 'coral' },
  { name: 'Tool library', kind: 'squircle', colour: 'sage' },
  { name: 'Volunteer rota', kind: 'daisy', colour: 'peach' },
] as const;

/** The big shape in the "make it whatever you want" panel, on cobalt */
const ANYTHING = [
  { kind: 'flower', colour: 'peach' },
  { kind: 'squircle', colour: 'coral' },
  { kind: 'burst', colour: 'lilac' },
  { kind: 'clover', colour: 'paper' },
  { kind: 'star', colour: 'peach' },
  { kind: 'scallop', colour: 'coral' },
  { kind: 'sparkle', colour: 'lilac' },
] as const;

/** Shapes for the small things, in turn */
const SMALL: readonly ShapeKind[] = [
  'scallop',
  'flower',
  'sparkle',
  'clover',
  'burst',
  'half',
  'daisy',
  'star',
];

/** A space, drawn as a sheet of shapes: what it starts with, and a cell that keeps becoming something new */
function SpaceGrid() {
  const [made, setMade] = useState(0);
  return (
    <div className="space-grid" id="inside" aria-hidden>
      {BUILT_IN.map((item, i) => (
        <div key={item.name} className="cell">
          <span className="cell-num">{String(i + 1).padStart(2, '0')}</span>
          <Shape {...shapeFor(item.id)} />
          <span className="cell-name">{item.name}</span>
        </div>
      ))}
      <div className="cell cell-new">
        <span className="cell-num">08</span>
        <Morph steps={MADE} onTurn={setMade} />
        <span className="cell-name" key={made}>
          {MADE[made]?.name}
        </span>
      </div>
    </div>
  );
}

/** A question decided by its votes, drawn after the Decisions app (`apps/example/src/components/apps/Decisions.tsx`) */
const DECIDED = (
  <div className="proposal">
    <div className="proposal-head">
      <b>Paint the clubhouse green?</b>
      <span className="tag">Decided</span>
    </div>
    <div className="by">Sam · 5 yeses decide it</div>
    <div className="tally">
      {[
        { option: 'Yes', votes: 5, won: true },
        { option: 'No', votes: 2, won: false },
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

/** The three things a minca builds, each drawn as one of the shapes */
const TRADITION: ReadonlyArray<{ shape: ShapeKind; colour: string; title: string; body: string }> = [
  {
    shape: 'arch',
    colour: 'c-cobalt',
    title: 'A bridge',
    body: 'Every June, Quechua villages in Peru rebuild a grass-rope bridge over the Apurímac river, by hand. They’ve done it for five hundred years.',
  },
  {
    shape: 'squircle',
    colour: 'c-coral',
    title: 'A school',
    body: 'Families bring bricks, roof beams and a pot of soup for whoever’s lifting. Nobody’s hired. Everybody comes.',
  },
  {
    shape: 'daisy',
    colour: 'c-sage',
    title: 'The harvest',
    body: 'This week everyone helps bring in one family’s potatoes. Next week, the next family’s.',
  },
];

/** Tools too small for any company to make, and exactly right for one group: two rows that drift past */
const IDEAS: readonly [readonly string[], readonly string[]] = [
  [
    'Carpool',
    'Volunteer rota',
    'Tool library',
    'Potluck sign-up',
    'Seed swap',
    'Lost and found',
    'Match availability',
    'Repair tracker',
    'Kit rota',
    'Babysitting circle',
    'Rent strike tracker',
    'Choir parts',
  ],
  [
    'Book club picks',
    'Chore wheel',
    'Shared budget',
    'Garden plot map',
    'Skill share',
    'Mutual aid',
    'Bike repair queue',
    'Recipe book',
    'Climbing partners',
    'Street party',
    'Grant tracker',
    'Lending shelf',
  ],
];

/** One tool travelling between groups; each one adds a piece, and the shape grows with it */
const TRAVELS: ReadonlyArray<{ group: string; change: string }> = [
  { group: 'Riverside FC', change: 'Makes a carpool for away games' },
  { group: 'Northside Hockey', change: 'Adds a waitlist' },
  { group: 'Oak Primary parents', change: 'Adds a school-run rota' },
];

/** The carpool's shape after `pieces` groups have had it */
function Grown({ pieces }: { pieces: number }) {
  return (
    <svg className="grown" viewBox="0 0 100 100" aria-hidden>
      <path className="fill c-cobalt" d="M8 92A42 42 0 0 1 92 92Z" />
      {pieces > 1 ? <circle className="fill c-coral" cx="50" cy="34" r="16" /> : null}
      {pieces > 2 ? (
        <path
          className="fill c-peach"
          d="M84 4C85.5 15 89 18.5 100 20 89 21.5 85.5 25 84 36 82.5 25 79 21.5 68 20 79 18.5 82.5 15 84 4Z"
        />
      ) : null}
    </svg>
  );
}

/** A row of chips that drifts sideways forever; drawn twice so the loop has no seam */
function Drift({ items, offset, reverse }: { items: readonly string[]; offset: number; reverse?: boolean }) {
  const chip = (idea: string, i: number, copy: string) => (
    <span key={`${copy}-${idea}`} className="chip-idea" aria-hidden={copy === 'b'}>
      <Shape kind={SMALL[(i + offset) % SMALL.length] ?? 'scallop'} className={colour(i + offset)} />
      {idea}
    </span>
  );
  return (
    <div className={reverse ? 'drift reverse' : 'drift'}>
      <div className="drift-track">
        {items.map((idea, i) => chip(idea, i, 'a'))}
        {items.map((idea, i) => chip(idea, i, 'b'))}
      </div>
    </div>
  );
}

/** Short points side by side, each marked with a small shape */
function Marked({ items }: { items: ReadonlyArray<{ title: string; body: string }> }) {
  return (
    <div className="ruled marked">
      {items.map((item, i) => (
        <div key={item.title}>
          <Shape kind={SMALL[i * 2] ?? 'scallop'} className={colour(i)} />
          <h3>{item.title}</h3>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Home() {
  return (
    <Page page="home">
      <section className="hero">
        <div className="wrap">
          <h1>
            Many hands
            <br />
            make it happen.
          </h1>
          <p>
            One place for your club, your street or your crew to talk, plan and get things done. Need
            something that doesn’t exist yet? Make it.
          </p>
          <div className="actions">
            <a href="/app" className="btn btn-primary btn-lg">
              Start a minca
            </a>
            <a href="#how" className="btn btn-secondary btn-lg">
              See how
            </a>
          </div>
          <SpaceGrid />
        </div>
      </section>

      <section className="band story" id="minca">
        <div className="wrap">
          <div className="section-head">
            <h2>In the Andes, nobody waits for someone else to build the bridge.</h2>
            <p>
              They call it a minca. When something would help everyone, everyone shows up and builds it
              together.
            </p>
          </div>
          <div className="ruled tradition">
            {TRADITION.map((item) => (
              <div key={item.title}>
                <Shape kind={item.shape} className={item.colour} />
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
          <p className="story-turn">
            Your club, your street and your crew work the same way. <b>Minca gives them a place to build.</b>
          </p>
        </div>
      </section>

      <section className="band abundance">
        <div className="wrap">
          <div className="abundance-panel">
            <Morph steps={ANYTHING} className="panel-morph" />
            <div className="section-head">
              <h2>If you can say it, you can have it.</h2>
              <p>
                Building an app used to take money and experts. Now you tell an AI what your group needs, and
                it’s there by tonight. No code, no servers, no bills.
              </p>
            </div>
            <div className="abundance-line">
              A carpool. A seed swap. A rota for the choir. <b>Whatever’s next.</b>
            </div>
            <div className="drifts" aria-label="Things groups make">
              <Drift items={IDEAS[0]} offset={0} />
              <Drift items={IDEAS[1]} offset={3} reverse />
            </div>
          </div>
        </div>
      </section>

      <Band id="how" title="“We need a carpool.” Done by teatime.">
        <ol className="ruled steps-row">
          {[
            { title: 'Ask', body: 'Tell Claude, ChatGPT or any AI what your group needs.' },
            { title: 'Agree', body: 'Everyone can see what it does. Your group says yes.' },
            { title: 'Use', body: 'It’s there for everyone, on every phone.' },
          ].map((step, i) => (
            <li key={step.title}>
              <span className="step-num">
                <Shape kind="scallop" className={colour(i)} />
                <b>{i + 1}</b>
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="how-demo">
          <HeroSpace />
        </div>
      </Band>

      <section className="band shared">
        <div className="wrap">
          <div className="section-head">
            <h2>Good ideas spread.</h2>
            <p>Made something great? Pass it to another group. They make it theirs, and pass it on.</p>
          </div>
          <div className="travels">
            {TRAVELS.map((stop, i) => (
              <div key={stop.group} className="travel">
                <span className="cell-num">v{i + 1}</span>
                <Grown pieces={i + 1} />
                <div className="travel-tool">Carpool</div>
                <b className="travel-group">{stop.group}</b>
                <p>{stop.change}</p>
              </div>
            ))}
          </div>
          <Marked
            items={[
              {
                title: 'Nothing to sell',
                body: 'No ads, no subscriptions. Things get made because someone needed them.',
              },
              { title: 'Remix anything', body: 'Take any tool and ask your AI to change it.' },
              { title: 'Smarter together', body: 'What one group figures out, every group gets.' },
              { title: 'Safe to try', body: 'A new tool only sees its own stuff. Your chats stay yours.' },
            ]}
          />
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>When enough of you agree, it’s decided.</h3>
              <p>
                Ask a question and pick how many votes it takes. Nobody has to count, and nobody can fake it.
              </p>
              <ul>
                <li>Five yeses and the clubhouse gets painted</li>
                <li>A fundraiser that closes when it hits the goal</li>
              </ul>
            </div>
            <div className="mock-card" aria-hidden>
              <div className="mock">{DECIDED}</div>
            </div>
          </div>
        </div>
      </section>

      <Band title="Your space. Not a platform’s.">
        <Marked
          items={[
            { title: 'No ads, no feed', body: 'Nobody’s watching, and nothing decides what you see.' },
            { title: 'Your rules', body: 'Your group decides who can do what.' },
            { title: 'Private', body: 'Private spaces are locked on your phone before anything leaves it.' },
            { title: 'Works offline', body: 'On the bus, in the field, in the basement.' },
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
          <div className="cta-mark" aria-hidden>
            {(['scallop', 'flower', 'half', 'star', 'clover'] as const).map((kind, i) => (
              <Shape key={kind} kind={kind} className={colour(i)} />
            ))}
          </div>
          <h2>Call your people.</h2>
          <p>Start a minca and make it yours.</p>
          <div className="actions">
            <a href="/app" className="btn btn-primary btn-lg">
              Start a minca
            </a>
          </div>
          <a href="/developers" className="aside-link">
            Building apps? Minca is an open protocol too →
          </a>
        </div>
      </section>
    </Page>
  );
}
