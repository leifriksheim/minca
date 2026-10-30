import { useEffect, useState, type PointerEvent, type ReactNode } from 'react';
import { Shape } from '@minca/app-shared/shapes';
import { TOOL_SHAPES as APP_SHAPES, markFor, shapeFor } from '@minca/ui/shapes';
import type { ShapeColour } from '@minca/ui/tokens';
import { EventHead, Face } from './demos';

/**
 * The apps a space starts with, drawn small as the app draws them; under
 * them the pieces they share, and new apps made of the same pieces. One app
 * at a time is lit on its colour's ground, and so are the pieces it uses.
 */

type PieceId = 'profile' | 'message' | 'file' | 'event' | 'place' | 'poll' | 'task';

/** The standard collections the picture uses (`std.event` and so on) */
const PIECES: Readonly<Record<PieceId, string>> = {
  profile: 'People',
  message: 'Messages',
  file: 'Files',
  event: 'Events',
  place: 'Places',
  poll: 'Polls',
  task: 'Tasks',
};

/** The shape colours take turns down the pieces, so chips side by side differ */
const CYCLE: readonly ShapeColour[] = ['cobalt', 'coral', 'peach', 'sage', 'lilac'];
const colourAt = (i: number): ShapeColour => CYCLE[i % CYCLE.length] ?? 'cobalt';

/** What each app is made of: the built-in ones in tiles, then the ones a group asks for */
const USES: Readonly<Record<string, readonly PieceId[]>> = {
  chat: ['message', 'file', 'profile'],
  events: ['event', 'place', 'profile'],
  polls: ['poll', 'profile'],
  kanban: ['task', 'profile'],
  carpool: ['place', 'event', 'message'],
  'book-club': ['event', 'poll', 'message'],
  chores: ['task', 'profile', 'event'],
};
const ORDER = Object.keys(USES);

/** New apps from the same pieces; one adds a piece of its own beside them */
const RECIPES: ReadonlyArray<{ id: string; name: string; own?: string }> = [
  { id: 'carpool', name: 'Carpool', own: 'Rides' },
  { id: 'book-club', name: 'Book club' },
  { id: 'chores', name: 'Chore rota' },
];

/** A built-in app's own shape and colour, the same as in the app's sidebar */
function AppMark({ id, size = 22 }: { id: string; size?: number }) {
  const shape = APP_SHAPES[id];
  return shape ? <Shape kind={shape.kind} colour={shape.colour} size={size} /> : null;
}

/** Pointing at an app lights it until the pointer leaves the picture; otherwise they take turns */
type Hold = { onPointerEnter: (event: PointerEvent) => void };
type Light = { lit: string; hold: (id: string) => Hold };

function Tile({
  id,
  name,
  size,
  light,
  children,
}: {
  id: string;
  name: string;
  /** Big takes two columns and two rows, wide two columns */
  size?: 'big' | 'wide';
  light: Light;
  children: ReactNode;
}) {
  // Each tile is washed in its app's own colour
  const colour = `c-${APP_SHAPES[id]?.colour ?? 'paper'}`;
  return (
    <div
      className={size ? `basic is-${size} ${colour}` : `basic ${colour}`}
      data-lit={light.lit === id || undefined}
      {...light.hold(id)}
    >
      <div className="basic-shot">{children}</div>
      <div className="basic-name">
        <AppMark id={id} />
        <b>{name}</b>
      </div>
    </div>
  );
}

/** One message: who said it, their face, and what they said */
function Said({
  who,
  name,
  at,
  children,
}: {
  who: Parameters<typeof Face>[0]['who'];
  name: string;
  at: string;
  children: ReactNode;
}) {
  return (
    <div className="msg">
      <Face who={who} />
      <div>
        <span className="msg-who">
          <b>{name}</b>
          <small>{at}</small>
        </span>
        {children}
      </div>
    </div>
  );
}

const CHAT = (
  <div className="mini-chat">
    <div className="mini-rooms">
      <span className="is-on"># general</span>
      <span># hack-night</span>
      <span># 3d-printer</span>
    </div>
    <div className="mini-thread">
      <Said who="maya" name="Maya" at="18:02">
        <p>Who’s around Thursday? The new soldering irons came.</p>
      </Said>
      <Said who="joe" name="Joe" at="18:05">
        <p>In. I’ll bring the long extension lead.</p>
        <div className="msg-card">
          <EventHead day="Thu" date="14" title="Hack night" meta="7pm · The Loft · 3 of 4 going" />
        </div>
        <span className="msg-reacts">
          <span>🔥 4</span>
          <span>🙌 2</span>
        </span>
      </Said>
      <Said who="anna" name="Anna" at="18:11">
        <p>Can someone fix the printer before then? It ate my bracket again.</p>
      </Said>
      <Said who="sam" name="Sam" at="18:14">
        <p>On it. Put it on the board so nobody else buys a new one.</p>
      </Said>
    </div>
    <div className="mini-compose">Message #general</div>
  </div>
);

const POLL = (
  <div className="mini-poll">
    <b>Pizza or tacos on Thursday?</b>
    {[
      { option: 'Tacos', votes: 7, won: true },
      { option: 'Pizza', votes: 4, won: false },
    ].map((row) => (
      <div key={row.option} className={row.won ? 'tally-row won' : 'tally-row'}>
        <span className="tally-bar" style={{ width: `${(row.votes / 11) * 100}%` }} />
        <span className="tally-option">{row.option}</span>
        <span className="tally-count">{row.votes}</span>
      </div>
    ))}
    <small>11 voted · closes tonight</small>
  </div>
);

type Who = Parameters<typeof Face>[0]['who'];

/** The workshop's board: a few jobs in each column, tagged, with whoever took them */
const BOARD: ReadonlyArray<{
  column: string;
  cards: ReadonlyArray<{ title: string; tag?: string; who?: Who }>;
}> = [
  {
    column: 'To do',
    cards: [
      { title: 'Order PLA filament', tag: 'Supplies', who: 'ola' },
      { title: 'Book the hall for May', tag: 'Events' },
      { title: 'Label the drawers' },
    ],
  },
  {
    column: 'Doing',
    cards: [
      { title: 'Fix the 3D printer', tag: 'Repair', who: 'sam' },
      { title: 'Soldering kit list', who: 'anna' },
    ],
  },
  {
    column: 'Done',
    cards: [
      { title: 'New soldering irons', who: 'joe' },
      { title: 'Clean the laser cutter', who: 'kai' },
    ],
  },
];

const KANBAN = (
  <div className="mini-board">
    <div className="mini-board-head">
      <b>Workshop jobs</b>
      <span className="app-pill">+ Add a card</span>
    </div>
    <div className="mini-board-columns">
      {BOARD.map(({ column, cards }) => (
        <div key={column} className="mini-board-column">
          <small>
            {column} <span>{cards.length}</span>
          </small>
          {cards.map((card) => (
            <div key={card.title} className={column === 'Done' ? 'mini-card is-done' : 'mini-card'}>
              <p>{card.title}</p>
              {card.tag || card.who ? (
                <div className="mini-card-foot">
                  {card.tag ? <span className="mini-tag">{card.tag}</span> : <span />}
                  {card.who ? <Face who={card.who} /> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  </div>
);

const EVENT = (
  <div className="app">
    <EventHead day="Sat" date="16" title="Potluck" meta="1pm · Ida’s garden" />
    <div className="app-row">
      <span>
        <b>Ida</b>
        <small>Salad, and the garden</small>
      </span>
      <Face who="ida" />
    </div>
    <div className="app-row">
      <span>
        <b>Joe</b>
        <small>Rice, apparently</small>
      </span>
      <Face who="joe" />
    </div>
    <div className="app-row">
      <span>Dessert</span>
      <span className="app-pill free">Bring it</span>
    </div>
  </div>
);

export function Pieces() {
  const [turn, setTurn] = useState(0);
  const [held, setHeld] = useState<string>();
  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setTurn((i) => (i + 1) % ORDER.length), 2400);
    return () => clearInterval(timer);
  }, []);
  const lit = held ?? ORDER[turn] ?? 'chat';
  const light: Light = {
    lit,
    // Only a mouse holds one; a tap on a phone would stop the turns for good
    hold: (id) => ({
      onPointerEnter: (event) => {
        if (event.pointerType === 'mouse') setHeld(id);
      },
    }),
  };
  const used = new Set<string>(USES[lit]);
  const own = RECIPES.find((recipe) => recipe.id === lit)?.own;
  // The pieces in use take the lit app's ground, so they read as its
  const litColour = APP_SHAPES[lit]?.colour ?? colourAt(RECIPES.findIndex((recipe) => recipe.id === lit) + 1);

  return (
    // Let go only on leaving the whole picture, so crossing the rule between two apps doesn't flicker
    <div className="pieces" onPointerLeave={() => setHeld(undefined)}>
      <div className="basics">
        <Tile id="chat" name="Chat" size="big" light={light}>
          {CHAT}
        </Tile>
        <Tile id="events" name="Events" light={light}>
          {EVENT}
        </Tile>
        <Tile id="polls" name="Polls" light={light}>
          {POLL}
        </Tile>
        <Tile id="kanban" name="Kanban" size="wide" light={light}>
          {KANBAN}
        </Tile>
      </div>

      <dl className={`pieces-key c-${litColour}`}>
        <div>
          <dt>Shared by all of them</dt>
          <dd>
            {Object.entries(PIECES).map(([id, name], i) => (
              <span key={id} className="piece" data-on={used.has(id) || undefined}>
                <Shape kind={markFor(`std.${id}`).kind} colour={colourAt(i)} size={14} />
                {name}
              </span>
            ))}
            {own ? (
              <span className="piece is-own" data-on>
                + {own}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>New apps, same pieces</dt>
          <dd>
            {RECIPES.map((recipe, i) => (
              <span
                key={recipe.id}
                className="piece is-app"
                data-on={lit === recipe.id || undefined}
                {...light.hold(recipe.id)}
              >
                <Shape kind={shapeFor(recipe.id).kind} colour={colourAt(i + 1)} size={14} />
                {recipe.name}
              </span>
            ))}
            <span className="piece is-ask">+ Ask for one</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
