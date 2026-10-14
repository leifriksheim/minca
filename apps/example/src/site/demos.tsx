import type { ReactNode } from 'react';

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
