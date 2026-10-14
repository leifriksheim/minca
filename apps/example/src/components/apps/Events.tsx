import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Shape, shapeFor } from '@minca/app-shared/shapes';
import { useAccount, useCan, useLive, useNode } from '@minca/core/react';
import type { IncludedOf, P2PNode, QueryRecord } from '@minca/core';
import { comment, event, rsvp, type CalendarEvent, type Rsvp } from '@minca/core/schemas';
import { Avatar } from '@minca/app-shared/Avatar';
import { Modal } from '@minca/app-shared/Modal';
import { respondingTo } from '../../derive/people';
import {
  addDays,
  clockOf,
  dateOf,
  dayKey,
  endOf,
  fromInputs,
  horizon,
  icsOf,
  isOn,
  isWholeDay,
  localZone,
  longWhen,
  rfc3339,
  shortWhen,
  startOfDay,
} from '../../derive/when';
import { styles, palette, ui } from '../../styles';
import { Person } from '../Person';
import { Comments } from '../std/Comments';
import { Cover, kindColour, kindOf, type Kind } from './Cover';
import {
  NearButton,
  NearContext,
  PlaceField,
  PlaceMap,
  inReach,
  nearWhere,
  placeLabel,
  useDistance,
  useNear,
  type Place,
} from './Where';
import type { AppProps } from './index';

/** What an event can be, for its cover and for browsing by kind. The last is the catch-all. */
const KINDS: ReadonlyArray<Kind> = [
  { id: 'music', label: 'Music', emoji: '🎸', hue: 275 },
  { id: 'meetup', label: 'Meetups', emoji: '👋', hue: 212 },
  { id: 'party', label: 'Parties', emoji: '🎉', hue: 330 },
  { id: 'food', label: 'Food & drink', emoji: '🍷', hue: 12 },
  { id: 'sports', label: 'Sports', emoji: '⚽', hue: 140 },
  { id: 'outdoors', label: 'Outdoors', emoji: '🏕️', hue: 95 },
  { id: 'arts', label: 'Arts & culture', emoji: '🎨', hue: 300 },
  { id: 'learning', label: 'Talks & classes', emoji: '💡', hue: 45 },
  { id: 'other', label: 'Other', emoji: '✨', hue: 232 },
];

/** Include this with an event to get who answered and what was said about it */
const withGuests = {
  rsvps: { rel: 'about', from: rsvp },
  comments: { rel: 'about', from: comment },
} as const;

type EventRecord = QueryRecord<CalendarEvent, IncludedOf<typeof withGuests>>;
type Answer = QueryRecord<Rsvp, IncludedOf<undefined>>;
type Status = Rsvp['status'];

type View = 'upcoming' | 'calendar' | 'mine' | 'hosting' | 'past';
const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'mine', label: 'Your plans' },
  { id: 'hosting', label: 'Hosting' },
  { id: 'past', label: 'Past' },
];

/** The time now, to the minute, so what counts as upcoming moves on while the app is open */
const Now = createContext(new Date(0));

function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * `std.event` and `std.rsvp`, the way people browse what's on: covers and
 * dates up front, what's next first, a month to look across, and on each
 * event who's going and a place to talk about it (`std.comment`).
 */
export function Events({ space }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const mayCreate = useCan(space.id, 'create', event.name) && space.writable;
  const [view, setView] = useState<View>('upcoming');
  const [kind, setKind] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<EventRecord | 'new' | null>(null);
  const now = useMinute();
  const [near, setNear] = useNear();

  const data = useLive(
    space.id,
    async () => {
      const soonest = (records: ReadonlyArray<EventRecord>) =>
        [...records].sort((a, b) => dateOf(a.body.start).getTime() - dateOf(b.body.start).getTime());
      const all = soonest(
        (await node.records.query(space.id, { collection: event, include: withGuests })).records,
      );
      if (!near) return { all, close: null };
      // The cells around the circle, as a keeper would match them; then the exact distance.
      const where = nearWhere(near);
      const candidates = where
        ? (await node.records.query(space.id, { collection: event, include: withGuests, where })).records
        : all;
      return { all, close: new Set(candidates.filter((e) => inReach(near, e.body.place)).map((e) => e.key)) };
    },
    [near?.lat, near?.lon, near?.km],
  );
  if (!data) return null;
  const events = data.all;
  // Somewhere near, or online: an event with a link and no place is anywhere.
  const browsable = (e: EventRecord) =>
    !data.close || data.close.has(e.key) || (!e.body.place?.lat && !!e.body.url);

  const form = editing && (
    <EventForm
      initial={editing === 'new' ? null : editing}
      onClose={() => setEditing(null)}
      onSave={async (body) => {
        if (editing === 'new') {
          const made = await node.records.put(space.id, event, body);
          setOpenKey(made.key);
        } else {
          await node.records.update(space.id, editing.key, body);
        }
        setEditing(null);
      }}
    />
  );

  const open = openKey ? events.find((e) => e.key === openKey) : undefined;
  if (open) {
    return (
      <Now.Provider value={now}>
        <NearContext.Provider value={near}>
          <EventPage
            space={space}
            record={open}
            onBack={() => setOpenKey(null)}
            onEdit={() => setEditing(open)}
          />
          {form}
        </NearContext.Provider>
      </Now.Provider>
    );
  }

  const upcoming = events.filter((e) => endOf(e.body) > now && browsable(e));
  const answerOf = (e: EventRecord) => latestAnswers(e).get(me)?.body.status;
  const inView =
    view === 'past'
      ? events.filter((e) => endOf(e.body) <= now && browsable(e)).reverse()
      : view === 'mine'
        ? events.filter((e) => endOf(e.body) > now && (answerOf(e) === 'going' || answerOf(e) === 'maybe'))
        : view === 'hosting'
          ? events.filter((e) => e.createdBy === me)
          : upcoming;
  const shown = kind ? inView.filter((e) => kindOf(KINDS, e.body.category).id === kind) : inView;
  const kindsHere = KINDS.filter((k) => events.some((e) => kindOf(KINDS, e.body.category).id === k.id));
  const openEvent = (e: EventRecord) => setOpenKey(e.key);

  return (
    <Now.Provider value={now}>
      <NearContext.Provider value={near}>
        <div style={{ ...ui.stack, gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="segmented scroll-x" role="tablist" aria-label="Events">
              {VIEWS.map((v) => (
                <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>
                  {v.label}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            {mayCreate && (
              <button onClick={() => setEditing('new')} data-variant="primary" style={styles.addButton}>
                + Create event
              </button>
            )}
          </div>

          {(view === 'upcoming' || view === 'calendar' || view === 'past') && (
            <div className="scroll-x" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <NearButton near={near} onChange={setNear} />
              {view !== 'calendar' && kindsHere.length > 1 && (
                <>
                  <span
                    aria-hidden
                    style={{ width: 1, height: 20, background: palette.surface.line, margin: '0 4px' }}
                  />
                  <KindChips kinds={kindsHere} chosen={kind} onChoose={setKind} />
                </>
              )}
            </div>
          )}

          {view === 'calendar' ? (
            <MonthView events={events.filter(browsable)} onOpen={openEvent} />
          ) : shown.length === 0 ? (
            <Empty view={view} mayCreate={mayCreate} filtered={!!kind} onCreate={() => setEditing('new')} />
          ) : view === 'upcoming' && !kind ? (
            <Upcoming space={space} events={shown} onOpen={openEvent} />
          ) : (
            <div className="ev-grid">
              {shown.map((e) => (
                <EventCard key={e.key} space={space} record={e} onOpen={() => openEvent(e)} />
              ))}
            </div>
          )}
          {form}
        </div>
      </NearContext.Provider>
    </Now.Provider>
  );
}

/** Kinds to browse by, as a row of chips that scrolls sideways on a phone */
function KindChips({
  kinds,
  chosen,
  onChoose,
}: {
  kinds: ReadonlyArray<Kind>;
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Kinds">
      <button
        aria-pressed={chosen === null}
        onClick={() => onChoose(null)}
        style={{ ...ui.chip, height: 32, ...(chosen === null ? ui.chipOn : {}) }}
      >
        All
      </button>
      {kinds.map((k) => (
        <button
          key={k.id}
          aria-pressed={chosen === k.id}
          onClick={() => onChoose(chosen === k.id ? null : k.id)}
          style={{ ...ui.chip, height: 32, ...(chosen === k.id ? ui.chipOn : {}) }}
        >
          <span aria-hidden>{k.emoji}</span> {k.label}
        </button>
      ))}
    </div>
  );
}

/** What's on: the very next thing large, then the rest by how soon */
function Upcoming({
  space,
  events,
  onOpen,
}: {
  space: AppProps['space'];
  events: ReadonlyArray<EventRecord>;
  onOpen: (e: EventRecord) => void;
}) {
  const now = useContext(Now);
  const [next, ...rest] = events;
  if (!next) return null;
  const groups = new Map<string, EventRecord[]>();
  for (const e of rest) {
    const label = horizon(dateOf(e.body.start), now);
    groups.set(label, [...(groups.get(label) ?? []), e]);
  }
  return (
    <div style={{ ...ui.stack, gap: 28 }}>
      <Hero space={space} record={next} onOpen={() => onOpen(next)} />
      {[...groups].map(([label, list]) => (
        <section key={label} style={{ ...ui.stack, gap: 12 }}>
          <h3 style={{ ...styles.sectionTitle, fontSize: 16 }}>{label}</h3>
          <div className="ev-grid">
            {list.map((e) => (
              <EventCard key={e.key} space={space} record={e} onOpen={() => onOpen(e)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The next event, given the room to sell itself */
function Hero({
  space,
  record,
  onOpen,
}: {
  space: AppProps['space'];
  record: EventRecord;
  onOpen: () => void;
}) {
  const body = record.body;
  const k = kindOf(KINDS, body.category);
  const now = useContext(Now);
  const live = dateOf(body.start) <= now;
  return (
    <article className="ev-hero" data-tile style={ui.card}>
      <button onClick={onOpen} aria-label={`Open ${body.title}`} style={bare}>
        <Cover kind={k} seed={record.key} size={96} className="ev-hero-cover">
          <DateTile when={body.start} large />
        </Cover>
      </button>
      <div style={{ ...ui.stack, gap: 10, padding: 24, justifyContent: 'center', minWidth: 0 }}>
        <span style={{ ...eyebrow, color: live ? palette.accent.good : palette.accent.base }}>
          {live ? 'Happening now' : `Next up · ${horizon(dateOf(body.start), now)}`}
        </span>
        <button onClick={onOpen} style={{ ...bare, textAlign: 'left' }}>
          <h2
            style={{
              fontSize: 26,
              fontFamily: palette.display,
              fontWeight: 700,
              letterSpacing: '-0.04em',
              color: palette.ink.strong,
              lineHeight: 1.15,
              wordBreak: 'break-word',
            }}
          >
            {body.title}
          </h2>
        </button>
        <Facts body={body} />
        {body.status === 'cancelled' && <Cancelled />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <Faces dids={whoAnswered(record, 'going')} />
          <span style={{ fontSize: 13, color: palette.ink.muted }}>{headcount(record)}</span>
        </div>
        {body.status !== 'cancelled' && space.writable && (
          <div style={{ marginTop: 6 }}>
            <RsvpButtons space={space} record={record} compact />
          </div>
        )}
      </div>
    </article>
  );
}

/** An event in a grid: cover and date, what and where, and who's coming */
function EventCard({
  space,
  record,
  onOpen,
}: {
  space: AppProps['space'];
  record: EventRecord;
  onOpen: () => void;
}) {
  const { did: me } = useAccount();
  const node = useNode();
  const body = record.body;
  const mine = latestAnswers(record).get(me);
  const past = endOf(body) <= useContext(Now);
  const interested = mine?.body.status === 'maybe' || mine?.body.status === 'going';
  const away = useDistance(body.place);
  return (
    <article data-tile style={{ ...ui.card, ...ui.stack, overflow: 'hidden' }}>
      <button onClick={onOpen} style={{ ...bare, ...ui.stack, flex: 1, textAlign: 'left' }}>
        <Cover
          kind={kindOf(KINDS, body.category)}
          seed={record.key}
          size={52}
          style={{ height: 132, width: '100%', opacity: past ? 0.7 : 1 }}
        >
          <DateTile when={body.start} />
          {body.status === 'cancelled' && (
            <span style={{ position: 'absolute', top: 10, right: 10 }}>
              <Cancelled />
            </span>
          )}
        </Cover>
        <div style={{ ...ui.stack, gap: 4, padding: '12px 14px 4px', minWidth: 0 }}>
          <span style={{ ...eyebrow, color: palette.accent.base }}>{shortWhen(body)}</span>
          <strong
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: palette.ink.strong,
              lineHeight: 1.3,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {body.title}
          </strong>
          {placeLabel(body.place) && (
            <span style={{ ...ui.ellipsis, fontSize: 13, color: palette.ink.muted }}>
              {[placeLabel(body.place), away].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      </button>
      <footer style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 14px' }}>
        <span style={{ ...ui.ellipsis, flex: 1, fontSize: 12, color: palette.ink.faint }}>
          {headcount(record) || 'Be the first to answer'}
        </span>
        {space.writable && !past && body.status !== 'cancelled' && (
          <button
            aria-pressed={interested}
            title={interested ? 'You answered' : 'Show you are interested'}
            onClick={() => void answer(node, space.id, record, me, mine, interested ? null : 'maybe')}
            data-variant={interested ? undefined : 'quiet'}
            style={interested ? { ...styles.darkSmall, height: 30 } : { ...styles.smallButton, height: 30 }}
          >
            {mine?.body.status === 'going' ? '✓ Going' : interested ? '★ Interested' : '☆ Interested'}
          </button>
        )}
      </footer>
    </article>
  );
}

/** One event's own page */
function EventPage({
  space,
  record,
  onBack,
  onEdit,
}: {
  space: AppProps['space'];
  record: EventRecord;
  onBack: () => void;
  onEdit: () => void;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const body = record.body;
  const k = kindOf(KINDS, body.category);
  const hosting = record.createdBy === me && space.writable;
  const past = endOf(body) <= useContext(Now);
  const cancelled = body.status === 'cancelled';
  const away = useDistance(body.place);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{ ...ui.stack, gap: 20 }}>
      <button onClick={onBack} data-variant="ghost" style={{ ...bare, ...backLink }}>
        ‹ All events
      </button>

      <Cover
        kind={k}
        seed={record.key}
        size={120}
        className="ev-banner"
        style={{ borderRadius: palette.radius.lg }}
      >
        <DateTile when={body.start} large />
      </Cover>

      <header style={{ ...ui.stack, gap: 8 }}>
        <span style={{ ...eyebrow, color: palette.accent.base, fontSize: 13 }}>{longWhen(body)}</span>
        <h1
          style={{
            fontSize: 30,
            fontFamily: palette.display,
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.15,
            color: palette.ink.strong,
            wordBreak: 'break-word',
          }}
        >
          {body.title}
        </h1>
        {placeLabel(body.place) && (
          <span style={{ fontSize: 15, color: palette.ink.muted }}>{placeLabel(body.place)}</span>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {cancelled && <Cancelled />}
          {past && !cancelled && <span style={styles.badge}>Ended</span>}
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          paddingBottom: 20,
          borderBottom: `1px solid ${palette.surface.line}`,
        }}
      >
        {space.writable && !past && !cancelled && <RsvpButtons space={space} record={record} />}
        <span style={{ flex: 1 }} />
        <button onClick={() => download(record)} data-variant="quiet" style={styles.smallButton}>
          Add to calendar
        </button>
        {hosting && (
          <>
            <button onClick={onEdit} data-variant="quiet" style={styles.smallButton}>
              Edit
            </button>
            {!past && (
              <button
                onClick={() =>
                  void node.records.update(space.id, record.key, {
                    ...body,
                    status: cancelled ? 'confirmed' : 'cancelled',
                  })
                }
                data-variant="quiet"
                style={styles.smallButton}
              >
                {cancelled ? 'Restore event' : 'Cancel event'}
              </button>
            )}
            <button
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                onBack();
                void node.records.delete(space.id, record.key);
              }}
              onBlur={() => setConfirmDelete(false)}
              data-variant="danger"
              style={{ ...styles.smallButton, color: palette.accent.danger }}
            >
              {confirmDelete ? 'Delete for everyone?' : 'Delete'}
            </button>
          </>
        )}
      </div>

      <div className="ev-detail">
        <div style={{ ...ui.stack, gap: 28, minWidth: 0 }}>
          <section style={{ ...ui.stack, gap: 14 }}>
            <h3 style={styles.sectionTitle}>Details</h3>
            <Fact icon="👤">
              Hosted by{' '}
              <Person did={record.createdBy} style={{ fontWeight: 600, color: palette.ink.strong }} />
            </Fact>
            <Fact icon={k.emoji}>{k.label}</Fact>
            <Fact icon="🕒">{longWhen(body)}</Fact>
            {placeLabel(body.place) && (
              <Fact icon="📍">
                {placeLabel(body.place)}
                {away && <span style={{ color: palette.ink.faint }}> · {away} away</span>}
              </Fact>
            )}
            <PlaceMap place={body.place} />
            {body.url && (
              <Fact icon="🔗">
                <a
                  href={body.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...link, wordBreak: 'break-all' }}
                >
                  {body.url.replace(/^https?:\/\//, '')}
                </a>
              </Fact>
            )}
            {body.description && (
              <p
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: palette.ink.body,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginTop: 4,
                }}
              >
                {body.description}
              </p>
            )}
          </section>
          <Comments
            space={space}
            target={record.key}
            targetAuthor={record.root}
            comments={record.included.comments}
          />
        </div>
        <Guests record={record} />
      </div>
    </div>
  );
}

/** Who answered, by answer */
function Guests({ record }: { record: EventRecord }) {
  const answers = [...latestAnswers(record).values()];
  const groups: ReadonlyArray<{ status: Status; label: string }> = [
    { status: 'going', label: 'Going' },
    { status: 'maybe', label: 'Interested' },
    { status: 'no', label: "Can't go" },
  ];
  return (
    <aside style={{ ...ui.card, ...ui.stack, gap: 18, padding: 18 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {groups.slice(0, 2).map((g) => (
          <div
            key={g.status}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: palette.radius.lg,
              background: palette.surface.sunken,
              ...ui.stack,
              gap: 2,
            }}
          >
            <strong style={{ fontSize: 22, fontWeight: 600, color: palette.ink.strong }}>
              {g.status === 'going'
                ? countOf(record, 'going')
                : answers.filter((a) => a.body.status === g.status).length}
            </strong>
            <span style={{ fontSize: 12, color: palette.ink.muted }}>{g.label}</span>
          </div>
        ))}
      </div>
      {groups.map((g) => {
        const these = answers.filter((a) => a.body.status === g.status);
        if (these.length === 0) return null;
        return (
          <section key={g.status} style={{ ...ui.stack, gap: 8 }}>
            <h4 style={{ ...styles.fieldLabel, margin: 0 }}>
              {g.label} · {these.length}
            </h4>
            {these.map((a) => (
              <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <Avatar did={a.root ?? a.author} size={24} />
                <Person did={a.root} />
                {!!a.body.guests && (
                  <span style={{ fontSize: 12, color: palette.ink.faint }}>+{a.body.guests}</span>
                )}
              </div>
            ))}
          </section>
        );
      })}
      {answers.length === 0 && (
        <p style={{ fontSize: 13, color: palette.ink.faint }}>Nobody has answered yet.</p>
      )}
    </aside>
  );
}

/** Going, Interested, Can't go: one answer per person, and choosing yours again takes it back */
function RsvpButtons({
  space,
  record,
  compact,
}: {
  space: AppProps['space'];
  record: EventRecord;
  compact?: boolean;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const mine = latestAnswers(record).get(me);
  const choices: ReadonlyArray<{ status: Status; label: string; on: string }> = [
    { status: 'going', label: 'Going', on: '✓ Going' },
    { status: 'maybe', label: 'Interested', on: '★ Interested' },
    { status: 'no', label: "Can't go", on: "Can't go" },
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {choices.map((c) => {
        const on = mine?.body.status === c.status;
        return (
          <button
            key={c.status}
            aria-pressed={on}
            onClick={() => void answer(node, space.id, record, me, mine, on ? null : c.status)}
            data-variant={on ? undefined : 'quiet'}
            style={on ? { ...styles.darkSmall, height: 36 } : { ...styles.smallButton, height: 36 }}
          >
            {on ? c.on : c.label}
          </button>
        );
      })}
      {mine?.body.status === 'going' && !compact && (
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: palette.ink.muted }}
        >
          Bringing
          <select
            value={mine.body.guests ?? 0}
            onChange={(e) =>
              void node.records.update(space.id, mine.key, { ...mine.body, guests: Number(e.target.value) })
            }
            style={{ ...styles.input, height: 36, width: 'auto', padding: '0 8px' }}
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'nobody' : `+${n}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** A month at a glance: every day, and what is on it */
function MonthView({
  events,
  onOpen,
}: {
  events: ReadonlyArray<EventRecord>;
  onOpen: (e: EventRecord) => void;
}) {
  const today = startOfDay(useContext(Now));
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [picked, setPicked] = useState<Date>(today);
  // Weeks start on Monday; six rows hold any month.
  const first = addDays(month, -((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const weekdays = days.slice(0, 7).map((d) => d.toLocaleDateString(undefined, { weekday: 'short' }));
  const on = (day: Date) => events.filter((e) => isOn(e.body, day));
  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  const pickedEvents = on(picked);

  return (
    <div style={{ ...ui.stack, gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => {
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            setPicked(today);
          }}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Today
        </button>
        <button onClick={() => shift(-1)} data-variant="quiet" aria-label="Previous month" style={arrow}>
          ‹
        </button>
        <button onClick={() => shift(1)} data-variant="quiet" aria-label="Next month" style={arrow}>
          ›
        </button>
      </div>

      <div className="ev-month" role="grid" aria-label="Month">
        {weekdays.map((w) => (
          <div key={w} className="ev-weekday" role="columnheader">
            {w}
          </div>
        ))}
        {days.map((day) => {
          const these = on(day);
          const isToday = dayKey(day) === dayKey(today);
          const isPicked = dayKey(day) === dayKey(picked);
          return (
            <div
              key={dayKey(day)}
              role="gridcell"
              className="ev-day"
              data-other={day.getMonth() !== month.getMonth() || undefined}
              data-picked={isPicked || undefined}
              onClick={() => setPicked(day)}
            >
              <span className="ev-day-number" data-today={isToday || undefined}>
                {day.getDate()}
              </span>
              {these.slice(0, 3).map((e) => {
                const k = kindOf(KINDS, e.body.category);
                return (
                  <button
                    key={e.key}
                    className="ev-chip"
                    onClick={(click) => {
                      click.stopPropagation();
                      onOpen(e);
                    }}
                    title={e.body.title}
                    style={{
                      background: palette.surface.sunken,
                      color: palette.ink.strong,
                      boxShadow: `inset 3px 0 0 ${palette.shapes[kindColour(k)]}`,
                      textDecoration: e.body.status === 'cancelled' ? 'line-through' : undefined,
                    }}
                  >
                    {isWholeDay(e.body.start) || e.body.allDay ? '' : `${clockOf(dateOf(e.body.start))} `}
                    {e.body.title}
                  </button>
                );
              })}
              {these.length > 3 && <span className="ev-more">+{these.length - 3} more</span>}
              {these.length > 0 && (
                <span className="ev-dots" aria-hidden>
                  {these.slice(0, 3).map((e) => (
                    <i
                      key={e.key}
                      style={{ background: palette.shapes[kindColour(kindOf(KINDS, e.body.category))] }}
                    />
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <section style={{ ...ui.stack, gap: 10 }}>
        <h3 style={styles.sectionTitle}>
          {picked.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </h3>
        {pickedEvents.length === 0 ? (
          <p style={{ fontSize: 14, color: palette.ink.faint }}>Nothing on this day.</p>
        ) : (
          pickedEvents.map((e) => <EventRow key={e.key} record={e} onOpen={() => onOpen(e)} />)
        )}
      </section>
    </div>
  );
}

/** An event in a list: its time, its title, its place */
function EventRow({ record, onOpen }: { record: EventRecord; onOpen: () => void }) {
  const body = record.body;
  const k = kindOf(KINDS, body.category);
  return (
    <button
      onClick={onOpen}
      data-row
      style={{
        ...bare,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: palette.radius.lg,
        textAlign: 'left',
        border: `1px solid ${palette.surface.line}`,
      }}
    >
      <Cover
        kind={k}
        seed={record.key}
        size={26}
        style={{ width: 48, height: 48, borderRadius: palette.radius.lg, flexShrink: 0 }}
      />
      <span style={{ ...ui.stack, gap: 2, minWidth: 0 }}>
        <strong style={{ ...ui.ellipsis, fontSize: 14, color: palette.ink.strong }}>{body.title}</strong>
        <span style={{ ...ui.ellipsis, fontSize: 13, color: palette.ink.muted }}>
          {shortWhen(body)}
          {placeLabel(body.place) ? ` · ${placeLabel(body.place)}` : ''}
        </span>
      </span>
      <span style={{ marginLeft: 'auto', fontSize: 12, color: palette.ink.faint, whiteSpace: 'nowrap' }}>
        {headcount(record)}
      </span>
    </button>
  );
}

/** Making an event, or changing one: what, when, where */
function EventForm({
  initial,
  onSave,
  onClose,
}: {
  initial: EventRecord | null;
  onSave: (body: CalendarEvent) => Promise<void>;
  onClose: () => void;
}) {
  const was = initial?.body;
  const near = useContext(NearContext);
  const [start] = useState(() => (was ? dateOf(was.start) : addDays(startOfDay(new Date()), 1)));
  const end = was?.end ? dateOf(was.end) : null;
  const [title, setTitle] = useState(was?.title ?? '');
  const [category, setCategory] = useState(was ? kindOf(KINDS, was.category).id : 'meetup');
  const [allDay, setAllDay] = useState(was ? !!was.allDay || isWholeDay(was.start) : false);
  const [day, setDay] = useState(dayKey(start));
  const [clock, setClock] = useState(was && !isWholeDay(was.start) ? clockOf(start) : '19:00');
  const [endDay, setEndDay] = useState(end ? dayKey(end) : '');
  const [endClock, setEndClock] = useState(end && was?.end && !isWholeDay(was.end) ? clockOf(end) : '');
  const [place, setPlace] = useState<Place | undefined>(was?.place);
  const [url, setUrl] = useState(was?.url ?? '');
  const [description, setDescription] = useState(was?.description ?? '');
  const [busy, setBusy] = useState(false);

  const startAt = allDay ? day : day && clock ? rfc3339(fromInputs(day, clock)) : '';
  const endAt = allDay
    ? endDay && endDay > day
      ? endDay
      : ''
    : endClock
      ? rfc3339(fromInputs(endDay || day, endClock))
      : '';
  const backwards = !!endAt && !allDay && dateOf(endAt) <= dateOf(startAt);
  const badUrl = !!url.trim() && !/^https?:\/\/\S+$/.test(url.trim());
  const ready = !!title.trim() && !!startAt && !backwards && !badUrl;

  return (
    <Modal title={initial ? 'Edit event' : 'Create event'} onClose={onClose} width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          void onSave({
            title: title.trim(),
            category,
            start: startAt,
            ...(endAt ? { end: endAt } : {}),
            ...(allDay ? { allDay: true } : { tz: localZone() }),
            ...(place ? { place } : {}),
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(was?.status ? { status: was.status } : {}),
            ...(was?.rrule ? { rrule: was.rrule } : {}),
          }).finally(() => setBusy(false));
        }}
        style={{ ...ui.stack, gap: 14 }}
      >
        <Field label="Name">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Summer concert in the park"
            maxLength={500}
            style={styles.input}
          />
        </Field>
        <Field label="Kind" group>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                aria-pressed={category === k.id}
                onClick={() => setCategory(k.id)}
                style={{ ...ui.chip, height: 30, ...(category === k.id ? ui.chipOn : {}) }}
              >
                <span aria-hidden>{k.emoji}</span> {k.label}
              </button>
            ))}
          </div>
        </Field>
        <div className="ev-form-row">
          <Field label="Starts">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={styles.input} />
          </Field>
          {!allDay && (
            <Field label="At">
              <input
                type="time"
                value={clock}
                onChange={(e) => setClock(e.target.value)}
                style={styles.input}
              />
            </Field>
          )}
        </div>
        <div className="ev-form-row">
          <Field label="Ends (optional)">
            <input
              type="date"
              value={endDay}
              min={day}
              onChange={(e) => setEndDay(e.target.value)}
              style={styles.input}
            />
          </Field>
          {!allDay && (
            <Field label="At">
              <input
                type="time"
                value={endClock}
                onChange={(e) => setEndClock(e.target.value)}
                style={styles.input}
              />
            </Field>
          )}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>
        {backwards && <p style={styles.error}>It ends before it starts.</p>}
        <Field label="Where" group>
          <PlaceField
            value={place}
            onChange={setPlace}
            near={near}
            placeholder="A venue, an address, a park"
          />
        </Field>
        <Field label="Link (tickets, stream, page)">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            inputMode="url"
            style={styles.input}
          />
        </Field>
        {badUrl && <p style={styles.error}>A link starts with https://</p>}
        <Field label="About">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What to expect, what to bring, who's playing"
            rows={4}
            maxLength={10000}
            style={{
              ...styles.input,
              height: 'auto',
              padding: '10px 12px',
              resize: 'vertical',
              lineHeight: 1.5,
            }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} data-variant="quiet" style={styles.smallButton}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready || busy}
            data-variant="primary"
            style={{ ...styles.addButton, height: 32 }}
          >
            {busy ? 'Saving…' : initial ? 'Save' : 'Create event'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A labelled field; a row of choices is a group instead, since a label would name only its first button */
function Field({ label, group, children }: { label: string; group?: boolean; children: ReactNode }) {
  const style = { ...ui.stack, gap: 6, flex: 1, minWidth: 0 };
  const title = <span style={{ ...styles.fieldLabel, margin: 0 }}>{label}</span>;
  return group ? (
    <div role="group" aria-label={label} style={style}>
      {title}
      {children}
    </div>
  ) : (
    <label style={style}>
      {title}
      {children}
    </label>
  );
}

/** Nothing to show, said for the tab it is on */
function Empty({
  view,
  mayCreate,
  filtered,
  onCreate,
}: {
  view: View;
  mayCreate: boolean;
  filtered: boolean;
  onCreate: () => void;
}) {
  const said: Record<View, string> = {
    upcoming: 'Nothing coming up yet.',
    calendar: '',
    mine: "You haven't said you're going to anything yet.",
    hosting: "You aren't hosting anything.",
    past: 'No past events.',
  };
  return (
    <div style={{ ...styles.emptyState, ...ui.stack, gap: 12, alignItems: 'center', padding: '48px 16px' }}>
      <Shape {...shapeFor('events')} size={40} />
      <span>{filtered ? 'Nothing of this kind here.' : said[view]}</span>
      {mayCreate && (view === 'upcoming' || view === 'hosting') && !filtered && (
        <button
          onClick={onCreate}
          data-variant="primary"
          style={{ ...styles.addButton, alignSelf: 'center' }}
        >
          Create an event
        </button>
      )}
    </div>
  );
}

/** A tear-off calendar page in a cover's corner */
function DateTile({ when, large }: { when: string; large?: boolean }) {
  const date = dateOf(when);
  return (
    <span
      style={{
        position: 'absolute',
        top: large ? 16 : 10,
        left: large ? 16 : 10,
        ...ui.stack,
        alignItems: 'center',
        width: large ? 60 : 46,
        padding: large ? '6px 0 8px' : '4px 0 6px',
        borderRadius: palette.radius.lg,
        background: palette.surface.card,
        border: `1px solid ${palette.surface.rule}`,
        boxShadow: palette.shadow.small,
      }}
    >
      <span
        style={{
          fontSize: large ? 12 : 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: palette.accent.base,
        }}
      >
        {date.toLocaleDateString(undefined, { month: 'short' }).replace('.', '')}
      </span>
      <span
        style={{
          fontSize: large ? 26 : 20,
          fontWeight: 700,
          lineHeight: 1.05,
          color: palette.ink.strong,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {date.getDate()}
      </span>
    </span>
  );
}

/** When and where, one line each */
function Facts({ body }: { body: CalendarEvent }) {
  return (
    <div style={{ ...ui.stack, gap: 4, fontSize: 14, color: palette.ink.muted }}>
      <span>🕒 {longWhen(body)}</span>
      {placeLabel(body.place) && <span>📍 {placeLabel(body.place)}</span>}
    </div>
  );
}

function Fact({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 14, color: palette.ink.body }}>
      <span aria-hidden style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

function Cancelled() {
  return (
    <span
      style={{
        ...styles.badge,
        background: palette.accent.dangerSoft,
        borderColor: palette.accent.danger,
        color: palette.accent.danger,
        fontWeight: 600,
      }}
    >
      Cancelled
    </span>
  );
}

/** A few faces, overlapping */
function Faces({ dids }: { dids: ReadonlyArray<string> }) {
  if (dids.length === 0) return null;
  return (
    <span style={{ display: 'flex' }}>
      {dids.slice(0, 5).map((did, i) => (
        <span
          key={did}
          style={{
            marginLeft: i ? -8 : 0,
            borderRadius: palette.radius.pill,
            boxShadow: `0 0 0 2px ${palette.surface.card}`,
          }}
        >
          <Avatar did={did} size={26} />
        </span>
      ))}
    </span>
  );
}

/**
 * Each person's answer. One per person is the rule (`onePer`), but two
 * devices can each write one before they sync, so the newest counts.
 */
function latestAnswers(record: EventRecord): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  for (const a of record.included.rsvps) {
    const who = a.root ?? a.author;
    const had = answers.get(who);
    if (!had || had.updatedAt < a.updatedAt) answers.set(who, a);
  }
  return answers;
}

const whoAnswered = (record: EventRecord, status: Status) =>
  [...latestAnswers(record).values()].filter((a) => a.body.status === status).map((a) => a.root ?? a.author);

/** How many are coming: each person going, and whoever they bring */
const countOf = (record: EventRecord, status: Status) =>
  [...latestAnswers(record).values()]
    .filter((a) => a.body.status === status)
    .reduce((sum, a) => sum + 1 + (status === 'going' ? (a.body.guests ?? 0) : 0), 0);

/** "12 going · 4 interested", or nothing yet */
function headcount(record: EventRecord): string {
  const going = countOf(record, 'going');
  const maybe = countOf(record, 'maybe');
  return [going && `${going} going`, maybe && `${maybe} interested`].filter(Boolean).join(' · ');
}

/** Answering, changing an answer, or (with null) taking it back */
async function answer(
  node: P2PNode,
  spaceId: string,
  record: EventRecord,
  me: string,
  mine: Answer | undefined,
  status: Status | null,
): Promise<void> {
  if (status === null) {
    if (mine) await node.records.delete(spaceId, mine.key);
    return;
  }
  if (mine) {
    await node.records.update(spaceId, mine.key, { ...mine.body, status });
    return;
  }
  await node.records.put(
    spaceId,
    rsvp.name,
    { status, ...respondingTo(record.root, me) },
    { links: [{ rel: 'about', to: record.key }] },
  );
}

/** The event as a file a calendar app opens */
function download(record: EventRecord) {
  const body = record.body;
  const file = new Blob(
    [
      icsOf(record.key, {
        ...body,
        location: placeLabel(body.place) || undefined,
      }),
    ],
    { type: 'text/calendar' },
  );
  const a = globalThis.document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `${body.title.replace(/[^\w -]+/g, '').trim() || 'event'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const bare: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
};
const eyebrow: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};
const backLink: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 13,
  fontWeight: 500,
  color: palette.ink.muted,
};
const link: CSSProperties = {
  color: palette.ink.strong,
  textDecoration: 'underline',
  textDecorationColor: palette.surface.lineStrong,
  textUnderlineOffset: 3,
};
const arrow: CSSProperties = { ...styles.smallButton, width: 32, padding: 0, fontSize: 16 };
