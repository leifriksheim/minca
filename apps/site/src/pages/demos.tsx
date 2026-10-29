import type { ReactNode } from 'react';

/**
 * The tiny working apps the front page shows: tools a group made for itself,
 * drawn as the app would draw them. Each takes what has happened so far, so a
 * demo can show it before and after someone uses it, or before and after a
 * change.
 */

/**
 * The people in the demos, each a face in `public/faces/`: free portraits
 * from Unsplash (unsplash.com/license), by their photo id
 */
const FACES = {
  maya: { name: 'Maya', photo: '1494790108377-be9c29b29330' },
  joe: { name: 'Joe', photo: '1507003211169-0a1dd7228f2d' },
  anna: { name: 'Anna', photo: '1531123897727-8f129e1688ce' },
  sam: { name: 'Sam', photo: '1539571696357-5a69c17a67c6' },
  lea: { name: 'Lea', photo: '1520813792240-56fc4a3765a7' },
  leo: { name: 'Leo', photo: '1500648767791-00dcc994a43e' },
  ben: { name: 'Ben', photo: '1472099645785-5658abf4ff4e' },
  kai: { name: 'Kai', photo: '1534528741775-53994a69daeb' },
  ola: { name: 'Ola', photo: '1438761681033-6461ffad8d80' },
  ida: { name: 'Ida', photo: '1544005313-94ddf0286df2' },
} as const;
type Person = keyof typeof FACES;

/** Someone's face, round; `target` lets a hero cursor find it */
export function Face({ who, target }: { who: Person; target?: string }) {
  return (
    <img
      className="app-face"
      src={`/faces/${who}.jpg`}
      alt={FACES[who].name}
      width={24}
      height={24}
      data-target={target}
    />
  );
}

/** Spots in a row: a face where someone took one, an empty ring where one is open */
function Spots({ taken, of }: { taken: readonly Person[]; of: number }) {
  return (
    <span className="app-spots">
      {Array.from({ length: of }, (_, i) => {
        const who = taken[i];
        return who ? <Face key={i} who={who} /> : <span key={i} className="app-spot" />;
      })}
    </span>
  );
}

/** An event's head: its date on a little calendar leaf, its name, when and where */
export function EventHead({
  day,
  date,
  title,
  meta,
}: {
  day: string;
  date: string;
  title: string;
  meta: string;
}) {
  return (
    <div className="app-event">
      <span className="app-date">
        <small>{day}</small>
        {date}
      </span>
      <span>
        <b>{title}</b>
        <small>{meta}</small>
      </span>
    </div>
  );
}

/** A row the latest change added, marked so the eye finds it */
function Fresh({ children }: { children: ReactNode }) {
  return <div className="app-row is-new">{children}</div>;
}

/** What a group asked to change about its meetup, in the "change anything" demo and the remixes */
export type MeetupChange = 'waitlist' | 'talks' | 'reminder';

export function Meetup({
  change,
  title = 'Hack night',
  day = 'Thu',
  date = '14',
  where = '7pm · The Loft',
}: {
  change?: MeetupChange;
  title?: string;
  day?: string;
  date?: string;
  where?: string;
}) {
  const full = change === 'waitlist';
  const going: readonly Person[] = full ? ['maya', 'leo', 'kai', 'ben'] : ['maya', 'leo', 'kai'];
  return (
    <div className="app">
      <EventHead day={day} date={date} title={title} meta={where} />
      {change === 'reminder' ? (
        <Fresh>
          <span>
            <b>Reminder</b>
            <small>Everyone gets a nudge the day before</small>
          </span>
          <span className="app-pill">On</span>
        </Fresh>
      ) : null}
      <div className="app-row">
        <span>
          Hosted by <b>Joe</b>
        </span>
        <Face who="joe" />
      </div>
      <div className="app-row">
        <span>
          <b>Going</b>
          <small>{full ? 'Full' : `${going.length} of 4 spots`}</small>
        </span>
        <Spots taken={going} of={4} />
      </div>
      {change === 'talks' ? (
        <Fresh>
          <span>
            <b>Lightning talks</b>
            <small>Anna on Rust · Sam on synths</small>
          </span>
          <span className="app-pill free">Give one</span>
        </Fresh>
      ) : null}
      {full ? (
        <Fresh>
          <span>
            <b>Waitlist</b>
            <small>First in line gets a spot that opens</small>
          </span>
          <span className="app-spots">
            <Face who="lea" />
            <Face who="ida" />
            <span className="app-pill free">Join</span>
          </span>
        </Fresh>
      ) : null}
    </div>
  );
}
