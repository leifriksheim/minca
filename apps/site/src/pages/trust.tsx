import { useEffect, useState, type ReactNode } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import type { ShapeKind } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { Face } from './demos';
import { Tabs } from './Site';

/**
 * The front page's two pictures of trust: a message locked on one device,
 * carried as noise and opened on another; and hosting, for a group and for
 * one person, the way the app's Hosting page shows it. The numbers are the
 * Minca host's own (`packages/cli/fly.toml`, spec 08 §1.1): 250 MB free for
 * an account, a group free up to 10 people writing and 500 MB, and about
 * $0.10 a GB a month past that.
 */

const MESSAGE = 'Potluck’s at mine on Saturday. Bring a chair!';
const NOISE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';

/** The message as the relay and the host hold it: noise of the same length, stirred now and then */
function scramble(text: string): string {
  return Array.from(text, (ch) => (ch === ' ' ? ' ' : NOISE[Math.floor(Math.random() * NOISE.length)])).join(
    '',
  );
}

/** A fixed first scramble, so the page renders the same on the server and in the browser */
const FIRST = 'Qx9’f 2k vL3p 0n Wz7m4kd8. Ry8hg c 4Lm0p!';

function Noise() {
  const [text, setText] = useState(FIRST);
  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setText(scramble(MESSAGE)), 700);
    return () => clearInterval(timer);
  }, []);
  return <code className="sealed-noise">{text}</code>;
}

function Padlock({ open }: { open?: boolean }) {
  return (
    <svg className="sealed-lock" viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="10.5" width="16" height="11" rx="3" fill="currentColor" />
      <path
        d={open ? 'M8 10.5V7a4 4 0 0 1 7.6-1.7' : 'M8 10.5V7a4 4 0 0 1 8 0v3.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Sealed() {
  return (
    <div className="frame sealed paper-grid">
      <div className="sealed-end">
        <small>Maya’s phone</small>
        <div className="sealed-bubble">
          <Face who="maya" />
          <p>{MESSAGE}</p>
        </div>
      </div>
      <div className="sealed-way">
        <span className="sealed-step">
          <Padlock />
          Locked here
        </span>
        <div className="sealed-middle">
          <small>What the relay and the host hold</small>
          <Noise />
          <span className="sealed-dot" />
        </div>
        <span className="sealed-step">
          <Padlock open />
          Opened there
        </span>
      </div>
      <div className="sealed-end">
        <small>Joe’s laptop</small>
        <div className="sealed-bubble is-theirs">
          <Face who="maya" />
          <p>{MESSAGE}</p>
        </div>
      </div>
    </div>
  );
}

function Cloud() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The card's head: online, and kept by a host that can't read it */
function HostHead() {
  return (
    <>
      <div className="hosting-head">
        <span>
          <Cloud />
          <b>Hosting</b>
        </span>
        <span className="hosting-online">Online</span>
      </div>
      <div className="hosting-host">
        <span>
          Kept online by <b>Minca host</b>
        </span>
        <span className="kept">Can’t read it</span>
      </div>
    </>
  );
}

/** How much of something free is used, as a line and a bar */
function Used({ label, used, of, share }: { label: string; used: string; of: string; share: number }) {
  return (
    <div className="hosting-used">
      <span>
        {label}
        <b>
          {used} <small>of {of}</small>
        </b>
      </span>
      <div className="hosting-meter">
        <span style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

const GROUP_CARD = (
  <div className="hosting">
    <HostHead />
    <div className="hosting-fund">
      <span className="hosting-sum">Free</span>
      <span>
        <b>Riverside Makers</b>
        <small>Free this month</small>
      </span>
    </div>
    <Used label="People writing" used="8" of="10" share={0.8} />
    <Used label="Size" used="320 MB" of="500 MB" share={0.64} />
    <div className="hosting-ready">
      <span className="hosting-faces">
        <Face who="maya" />
        <Face who="joe" />
        <Face who="anna" />
      </span>
      <span>
        <b>$6 in the fund</b>
        <small>Ready for when you grow</small>
      </span>
      <span className="btn btn-secondary hosting-chip-in">Chip in</span>
    </div>
  </div>
);

/** One person's own spaces, and how much each takes */
const MINE: ReadonlyArray<{ name: string; size: string; kind: ShapeKind; colour: ShapeColour }> = [
  { name: 'Notes', size: '12 MB', kind: 'scallop', colour: 'cobalt' },
  { name: 'Recipes', size: '31 MB', kind: 'flower', colour: 'peach' },
  { name: 'Trips', size: '41 MB', kind: 'clover', colour: 'sage' },
];

const PERSONAL_CARD = (
  <div className="hosting">
    <HostHead />
    <div className="hosting-fund">
      <span className="hosting-sum">Free</span>
      <span>
        <b>Your own spaces</b>
        <small>On every device, even with the others off</small>
      </span>
    </div>
    <Used label="Room" used="84 MB" of="250 MB" share={0.34} />
    <ul className="hosting-spaces">
      {MINE.map((space) => (
        <li key={space.name}>
          <Shape kind={space.kind} colour={space.colour} size={18} />
          <span>{space.name}</span>
          <small>{space.size}</small>
        </li>
      ))}
    </ul>
  </div>
);

const PLANS: ReadonlyArray<{
  id: string;
  name: string;
  shape: { kind: ShapeKind; colour: ShapeColour };
  title: string;
  text: string;
  free: readonly string[];
  after: string;
  card: ReactNode;
}> = [
  {
    id: 'groups',
    name: 'For groups',
    shape: { kind: 'group', colour: 'coral' },
    title: 'Free for most groups.',
    text: 'Minca’s host keeps a group’s space online for free while it stays small enough. Only the people writing count, so a big group where a few people post is free too.',
    free: ['Up to 10 people writing, and anyone reading', '500 MB of chats, plans and files'],
    after:
      'Grow past that and the group pays for itself from one fund anyone can chip in to, at about 10 cents a GB a month.',
    card: GROUP_CARD,
  },
  {
    id: 'personal',
    name: 'Just you',
    shape: { kind: 'key', colour: 'cobalt' },
    title: 'Free for your own stuff.',
    text: 'Your own spaces, like notes, recipes and trip plans, stay online on Minca’s host so they’re there on every device, even when the others are off.',
    free: ['250 MB for your own spaces', 'Syncing between your own devices, always'],
    after: 'Need more room? Top up a balance and pay about 10 cents a GB a month for what’s past it.',
    card: PERSONAL_CARD,
  },
];

/** Hosting, for a group or for one person, one tab each */
export function Hosting() {
  const [selected, setSelected] = useState('groups');
  return (
    <>
      <Tabs label="Who it’s for" items={PLANS} selected={selected} onSelect={setSelected}>
        {(plan) => (
          <div className="split split-even">
            <div>
              <h3>{plan.title}</h3>
              <p>{plan.text}</p>
              <ul className="hosting-free">
                {plan.free.map((line) => (
                  <li key={line}>
                    <Shape kind="tick" colour="sage" size={20} />
                    {line}
                  </li>
                ))}
              </ul>
              <p>{plan.after}</p>
              <p className="hosting-own">
                Or run your own host on a spare computer:{' '}
                <span className="install">
                  <span>$</span>
                  <code>minca host</code>
                </span>
              </p>
            </div>
            <div className="frame paper-grid">{plan.card}</div>
          </div>
        )}
      </Tabs>
      <div className="faq hosting-how">
        <details>
          <summary>Do we need a host at all?</summary>
          <p>
            No. Your phones and laptops sync straight with each other whenever two of them are online at the
            same time. Without a host, a new message waits on your device until someone else in the group
            opens Minca, so things can take a while to arrive when everyone’s busy.
          </p>
          <p>
            A host is just one more device that never sleeps. It keeps a locked copy, passes it on to whoever
            comes online, and can’t read any of it. Any host will do, and you can switch whenever you like.
          </p>
        </details>
      </div>
    </>
  );
}
