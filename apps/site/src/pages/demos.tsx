/**
 * The tiny working tools the front page shows, each made by a group for itself,
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
