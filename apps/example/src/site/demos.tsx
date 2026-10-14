import type { ReactNode } from 'react';
import type { RoundKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';

/**
 * The tiny working apps the front page shows: tools a group made for itself,
 * drawn as the app would draw them. Each takes what has happened so far, so a
 * demo can show it before and after someone uses it, or before and after a
 * change.
 */

function Initial({ name }: { name: string }) {
  return <span className="app-initial">{name[0]}</span>;
}

function Seats({ seats }: { seats: readonly string[] }) {
  return (
    <span className="app-seats">
      {seats.map((name, i) =>
        name ? <Initial key={i} name={name} /> : <span key={i} className="app-seat" />,
      )}
    </span>
  );
}

function Head({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="app-head">
      {title}
      <span>{meta}</span>
    </div>
  );
}

/** A row the latest change added, marked so the eye finds it */
function Fresh({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={on ? 'app-row is-new' : 'app-row'}>{children}</div>;
}

/** What a group asked to change about its carpool, in the "mend it" demo and the remixes */
export type CarpoolChange = 'waitlist' | 'home' | 'reminder';

export function Carpool({
  used = false,
  change,
  trip = 'Saturday · away at Northside',
}: {
  used?: boolean;
  change?: CarpoolChange;
  trip?: string;
}) {
  const full = change === 'waitlist';
  const rides = [
    { driver: 'Anna', seats: ['Maya', 'Leo', full ? 'Ben' : ''] },
    { driver: 'Joe', seats: ['Kai', 'Ola', used || full ? 'Sam' : ''] },
  ];
  return (
    <div className="app">
      <Head title={trip} meta={full ? 'Full' : '2 rides'} />
      {change === 'reminder' ? (
        <Fresh on>
          <span>
            <b>Reminder</b>
            <small>Drivers get a message Friday at 7pm</small>
          </span>
          <span className="app-pill">On</span>
        </Fresh>
      ) : null}
      {rides.map((ride) => (
        <div key={ride.driver} className="app-row">
          <span>
            <b>{ride.driver}</b> is driving
          </span>
          <Seats seats={ride.seats} />
        </div>
      ))}
      {change === 'waitlist' ? (
        <Fresh on>
          <span>
            <b>Waitlist</b>
            <small>First to get a seat if one opens</small>
          </span>
          <span className="app-seats">
            <Initial name="Lea" />
            <Initial name="Tom" />
            <span className="app-pill free">Join</span>
          </span>
        </Fresh>
      ) : null}
      {change === 'home' ? (
        <Fresh on>
          <span>
            <b>Coming home</b>
            <small>Joe drives back · 2 seats left</small>
          </span>
          <span className="app-pill free">Ride back</span>
        </Fresh>
      ) : null}
    </div>
  );
}

/** The carpool after a school's parents made it theirs: the same rides, every weekday */
export function SchoolRun() {
  return (
    <div className="app">
      <Head title="School run · this week" meta="1 open" />
      <div className="app-rota">
        <span />
        <span className="app-rota-label">There</span>
        <span className="app-rota-label">Back</span>
        <RotaRow day="Mon" slots={['Anna', 'Joe']} />
        <RotaRow day="Tue" slots={['Priya', 'Anna']} />
        <RotaRow day="Wed" slots={['Joe', '']} take="Drive" />
      </div>
    </div>
  );
}

function ToolLibrary({ used = false }: { used?: boolean }) {
  return (
    <div className="app">
      <Head title="Tools on the street" meta="3 listed" />
      {[
        { tool: 'Drill', owner: 'Tom', borrower: 'Lena' },
        { tool: 'Ladder', owner: 'Ali', borrower: used ? 'Ben' : '' },
        { tool: 'Pressure washer', owner: 'Priya', borrower: '' },
      ].map((item) => (
        <div key={item.tool} className="app-row">
          <span>
            <b>{item.tool}</b>
            <small>{item.owner}’s</small>
          </span>
          {item.borrower ? (
            <span className="app-pill">With {item.borrower}</span>
          ) : (
            <span className="app-pill free">Borrow</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Repairs({ used = false }: { used?: boolean }) {
  return (
    <div className="app">
      <Head title="Open repairs" meta="3 open" />
      {[
        { issue: 'Lift out of order', count: used ? 15 : 14, status: 'Sent to landlord' },
        { issue: 'Damp in stairwell B', count: 9, status: 'Reported' },
        { issue: 'Broken entry buzzer', count: 6, status: 'Reported' },
      ].map((item, i) => (
        <div key={item.issue} className="app-row">
          <span>
            <b>{item.issue}</b>
            <small>{item.status}</small>
          </span>
          <span className={used && i === 0 ? 'app-pill bump' : 'app-pill'}>{item.count} homes</span>
        </div>
      ))}
    </div>
  );
}

function RotaRow({ day, slots, take = 'Take it' }: { day: string; slots: readonly string[]; take?: string }) {
  return (
    <>
      <span className="app-rota-label">{day}</span>
      {slots.map((name, i) =>
        name ? (
          <span key={i} className="app-shift">
            <Initial name={name} /> {name}
          </span>
        ) : (
          <span key={i} className="app-shift open">
            {take}
          </span>
        ),
      )}
    </>
  );
}

function Rota({ used = false }: { used?: boolean }) {
  return (
    <div className="app">
      <Head title="This week" meta={used ? 'All covered' : '1 shift open'} />
      <div className="app-rota">
        <span />
        <span className="app-rota-label">Morning</span>
        <span className="app-rota-label">Afternoon</span>
        <RotaRow day="Mon" slots={['Kofi', 'Iris']} />
        <RotaRow day="Wed" slots={['Ben', 'Ola']} />
        <RotaRow day="Thu" slots={['Sam', used ? 'Ruth' : '']} />
      </div>
    </div>
  );
}

export function SeedSwap() {
  return (
    <div className="app">
      <Head title="Seeds to swap" meta="12 packets" />
      {[
        { seed: 'Cherry tomato', from: 'Ada', left: '4 left' },
        { seed: 'Runner beans', from: 'Femi', left: '2 left' },
        { seed: 'Nasturtium', from: 'Jo', left: 'Last one' },
      ].map((item) => (
        <div key={item.seed} className="app-row">
          <span>
            <b>{item.seed}</b>
            <small>From {item.from}</small>
          </span>
          <span className="app-pill">{item.left}</span>
        </div>
      ))}
    </div>
  );
}

export function ChoreWheel() {
  return (
    <div className="app">
      <Head title="Chores this week" meta="Turns on Sunday" />
      {[
        { chore: 'Bins out', who: 'Mo', done: true },
        { chore: 'Bathroom', who: 'Lin', done: false },
        { chore: 'Kitchen floor', who: 'Rafa', done: false },
      ].map((item) => (
        <div key={item.chore} className="app-row">
          <span>
            <b>{item.chore}</b>
            <small>{item.who}’s turn</small>
          </span>
          <span className={item.done ? 'app-pill bump' : 'app-pill free'}>
            {item.done ? 'Done' : 'Mark done'}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One group, the tool it asked for in its own words, and the tool: the gallery's cards */
interface Made {
  readonly tool: string;
  readonly kind: RoundKind;
  readonly colour: ShapeColour;
  readonly group: string;
  readonly ask: string;
  readonly app: (used: boolean) => ReactNode;
}

export const MADE: readonly Made[] = [
  {
    tool: 'Carpool',
    kind: 'clover',
    colour: 'coral',
    group: 'Riverside FC',
    ask: 'Can we sort out lifts to away games?',
    app: (used) => <Carpool used={used} />,
  },
  {
    tool: 'Tool library',
    kind: 'squircle',
    colour: 'sage',
    group: 'Elm Street',
    ask: 'Could we lend each other tools instead of all buying drills?',
    app: (used) => <ToolLibrary used={used} />,
  },
  {
    tool: 'Repairs',
    kind: 'star',
    colour: 'peach',
    group: 'Maple Court Tenants',
    ask: 'One list of everything the landlord hasn’t fixed.',
    app: (used) => <Repairs used={used} />,
  },
  {
    tool: 'Volunteer rota',
    kind: 'daisy',
    colour: 'cobalt',
    group: 'Northside Food Bank',
    ask: 'A rota where people can grab a shift themselves?',
    app: (used) => <Rota used={used} />,
  },
];
