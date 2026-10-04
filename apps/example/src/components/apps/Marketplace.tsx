import { useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, useCan, useLive, useNode } from '@weaveprotocol/core/react';
import type { IncludedOf, QueryRecord } from '@weaveprotocol/core';
import { comment, listing, order, orderUpdate, type Listing, type Money } from '@weaveprotocol/core/schemas';
import { Avatar } from '@weave/app-shared/Avatar';
import { Modal } from '@weave/app-shared/Modal';
import { respondingTo } from '../../derive/people';
import { ago } from '../../derive/time';
import { styles, palette, ui } from '../../styles';
import { Person } from '../Person';
import { Comments } from '../std/Comments';
import { Cover, kindOf, type Kind } from './Cover';
import type { AppProps } from './index';

/** What a listing can be, for its cover and for browsing. The last is the catch-all. */
const CATEGORIES: ReadonlyArray<Kind> = [
  { id: 'furniture', label: 'Furniture', emoji: '🛋️', hue: 28 },
  { id: 'electronics', label: 'Electronics', emoji: '🎧', hue: 220 },
  { id: 'clothes', label: 'Clothes', emoji: '👕', hue: 330 },
  { id: 'bikes', label: 'Bikes', emoji: '🚲', hue: 160 },
  { id: 'sports', label: 'Sports & outdoors', emoji: '🏂', hue: 190 },
  { id: 'home', label: 'Home & garden', emoji: '🪴', hue: 100 },
  { id: 'kids', label: 'Kids', emoji: '🧸', hue: 45 },
  { id: 'books', label: 'Books & media', emoji: '📚', hue: 260 },
  { id: 'music', label: 'Instruments', emoji: '🎸', hue: 295 },
  { id: 'tickets', label: 'Tickets', emoji: '🎟️', hue: 5 },
  { id: 'other', label: 'Other', emoji: '📦', hue: 38 },
];

const CONDITIONS: ReadonlyArray<{ id: NonNullable<Listing['condition']>; label: string }> = [
  { id: 'new', label: 'New' },
  { id: 'like-new', label: 'Like new' },
  { id: 'good', label: 'Good' },
  { id: 'fair', label: 'Fair' },
  { id: 'for-parts', label: 'For parts' },
];

const CURRENCIES = ['EUR', 'USD', 'GBP', 'NOK', 'SEK', 'DKK', 'CHF'] as const;

/**
 * Include this with a listing to get the requests for it, each with the
 * seller's answers, and the questions asked about it.
 */
const withRequests = {
  requests: { rel: 'about', from: order, include: { updates: { rel: 'about', from: orderUpdate } } },
  comments: { rel: 'about', from: comment },
} as const;

type ListingRecord = QueryRecord<Listing, IncludedOf<typeof withRequests>>;
type Request = ListingRecord['included']['requests'][number];
type Answer = 'waiting' | 'accepted' | 'declined';

type View = 'browse' | 'selling' | 'buying';
type Sort = 'new' | 'cheap' | 'dear';

/**
 * `std.listing`, the way people shop from neighbours: a grid of things with
 * their prices, browsed by category. Asking for something is a `std.order`
 * about it, and the seller answers with a `std.order-update`; only the
 * seller's answers count. Questions are `std.comment`s on the listing.
 */
export function Marketplace({ space }: AppProps) {
  const node = useNode();
  const { did: me } = useAccount();
  const maySell = useCan(space.id, 'create', listing.name) && space.writable;
  const [view, setView] = useState<View>('browse');
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('new');
  const [freeOnly, setFreeOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<ListingRecord | 'new' | null>(null);

  const listings = useLive(
    space.id,
    async () =>
      (
        await node.records.query(space.id, {
          collection: listing,
          sort: { '@createdAt': 'desc' },
          include: withRequests,
        })
      ).records,
    [],
  );
  if (!listings) return null;

  const form = editing && (
    <ListingForm
      initial={editing === 'new' ? null : editing}
      onClose={() => setEditing(null)}
      onSave={async (body) => {
        if (editing === 'new') {
          const made = await node.records.put(space.id, listing, body);
          setOpenKey(made.key);
        } else {
          await node.records.update(space.id, editing.key, body);
        }
        setEditing(null);
      }}
    />
  );

  const open = openKey ? listings.find((l) => l.key === openKey) : undefined;
  if (open) {
    return (
      <>
        <ListingPage
          space={space}
          record={open}
          onBack={() => setOpenKey(null)}
          onEdit={() => setEditing(open)}
        />
        {form}
      </>
    );
  }

  const words = search.trim().toLowerCase();
  const matches = (l: ListingRecord) =>
    !words ||
    [l.body.title, l.body.description, placeLabel(l.body.place)].some((t) =>
      t?.toLowerCase().includes(words),
    );
  const inView =
    view === 'selling'
      ? listings.filter((l) => l.createdBy === me)
      : view === 'buying'
        ? listings.filter((l) => myRequest(l, me))
        : listings.filter((l) => l.body.status !== 'sold');
  const shown = inView
    .filter((l) => !category || kindOf(CATEGORIES, l.body.category).id === category)
    .filter((l) => !freeOnly || isFree(l.body.price))
    .filter(matches)
    .sort((a, b) => (sort === 'new' ? 0 : (priceOf(a) - priceOf(b)) * (sort === 'cheap' ? 1 : -1)));
  const categoriesHere = CATEGORIES.filter((c) =>
    listings.some((l) => kindOf(CATEGORIES, l.body.category).id === c.id),
  );
  const waiting = listings
    .filter((l) => l.createdBy === me)
    .reduce((n, l) => n + l.included.requests.filter((r) => answerTo(r, l) === 'waiting').length, 0);

  return (
    <div style={{ ...ui.stack, gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="segmented scroll-x" role="tablist" aria-label="Marketplace">
          {(
            [
              ['browse', 'Browse'],
              ['selling', 'Selling'],
              ['buying', 'Buying'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}>
              {label}
              {id === 'selling' && waiting > 0 && <span className="count">{waiting}</span>}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {maySell && (
          <button onClick={() => setEditing('new')} data-variant="primary" style={styles.addButton}>
            + Sell something
          </button>
        )}
      </div>

      <div className="mk-tools">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the marketplace"
          aria-label="Search"
          style={{ ...styles.input, flex: 1, minWidth: 0 }}
        />
        <select
          value={sort}
          onChange={(e) => setSort(sortOf(e.target.value))}
          aria-label="Sort"
          style={{ ...styles.input, width: 'auto' }}
        >
          <option value="new">Newest first</option>
          <option value="cheap">Price: low to high</option>
          <option value="dear">Price: high to low</option>
        </select>
      </div>

      {categoriesHere.length > 0 && (
        <div className="scroll-x" style={{ display: 'flex', gap: 6 }} role="group" aria-label="Categories">
          <button
            aria-pressed={!category && !freeOnly}
            onClick={() => {
              setCategory(null);
              setFreeOnly(false);
            }}
            style={{ ...ui.chip, height: 32, ...(!category && !freeOnly ? ui.chipOn : {}) }}
          >
            All
          </button>
          <button
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly(!freeOnly)}
            style={{ ...ui.chip, height: 32, ...(freeOnly ? ui.chipOn : {}) }}
          >
            <span aria-hidden>🎁</span> Free
          </button>
          {categoriesHere.map((c) => (
            <button
              key={c.id}
              aria-pressed={category === c.id}
              onClick={() => setCategory(category === c.id ? null : c.id)}
              style={{ ...ui.chip, height: 32, ...(category === c.id ? ui.chipOn : {}) }}
            >
              <span aria-hidden>{c.emoji}</span> {c.label}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div
          style={{ ...styles.emptyState, ...ui.stack, gap: 12, alignItems: 'center', padding: '48px 16px' }}
        >
          <span aria-hidden style={{ fontSize: 36 }}>
            🛍️
          </span>
          <span>
            {words || category || freeOnly
              ? 'Nothing matches.'
              : view === 'selling'
                ? "You aren't selling anything."
                : view === 'buying'
                  ? "You haven't asked for anything yet."
                  : 'Nothing for sale yet.'}
          </span>
          {maySell && view !== 'buying' && !words && !category && !freeOnly && (
            <button
              onClick={() => setEditing('new')}
              data-variant="primary"
              style={{ ...styles.addButton, alignSelf: 'center' }}
            >
              Sell something
            </button>
          )}
        </div>
      ) : (
        <div className="mk-grid">
          {shown.map((l) => (
            <ListingCard key={l.key} record={l} onOpen={() => setOpenKey(l.key)} />
          ))}
        </div>
      )}
      {form}
    </div>
  );
}

/** A thing in the grid: its picture, its price, what it is and where */
function ListingCard({ record, onOpen }: { record: ListingRecord; onOpen: () => void }) {
  const { did: me } = useAccount();
  const body = record.body;
  const mineWaiting =
    record.createdBy === me
      ? record.included.requests.filter((r) => answerTo(r, record) === 'waiting').length
      : 0;
  return (
    <button onClick={onOpen} className="mk-card" style={{ ...bare, ...ui.stack, gap: 8, textAlign: 'left' }}>
      <Cover
        kind={kindOf(CATEGORIES, body.category)}
        seed={record.key}
        size={64}
        className="mk-photo"
        style={{
          aspectRatio: '1 / 1',
          width: '100%',
          borderRadius: 12,
          opacity: body.status === 'sold' ? 0.55 : 1,
        }}
      >
        {body.status && body.status !== 'available' && (
          <span style={{ ...pill, position: 'absolute', top: 10, left: 10 }}>
            {body.status === 'sold' ? 'Sold' : 'Reserved'}
          </span>
        )}
        {mineWaiting > 0 && (
          <span
            style={{
              ...pill,
              position: 'absolute',
              top: 10,
              right: 10,
              background: palette.ink.strong,
              color: '#fff',
            }}
          >
            {mineWaiting} {mineWaiting === 1 ? 'request' : 'requests'}
          </span>
        )}
      </Cover>
      <span style={{ ...ui.stack, gap: 2, minWidth: 0, padding: '0 2px' }}>
        <strong
          style={{
            fontSize: 16,
            fontWeight: 650,
            color: isFree(body.price) ? palette.accent.good : palette.ink.strong,
          }}
        >
          {priceLabel(body.price)}
        </strong>
        <span
          style={{
            fontSize: 14,
            color: palette.ink.body,
            lineHeight: 1.35,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {body.title}
        </span>
        <span style={{ ...ui.ellipsis, fontSize: 12, color: palette.ink.faint }}>
          {[placeLabel(body.place), ago(record.createdAt)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  );
}

/** One listing's own page: the thing, its seller, and asking for it */
function ListingPage({
  space,
  record,
  onBack,
  onEdit,
}: {
  space: AppProps['space'];
  record: ListingRecord;
  onBack: () => void;
  onEdit: () => void;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const body = record.body;
  const cat = kindOf(CATEGORIES, body.category);
  const selling = record.createdBy === me;
  const condition = CONDITIONS.find((c) => c.id === body.condition);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setStatus = (status: NonNullable<Listing['status']>) =>
    void node.records.update(space.id, record.key, { ...body, status });

  return (
    <div style={{ ...ui.stack, gap: 20 }}>
      <button onClick={onBack} data-variant="ghost" style={{ ...bare, ...backLink }}>
        ‹ Marketplace
      </button>
      <div className="mk-detail">
        <Cover
          kind={cat}
          seed={record.key}
          size={140}
          style={{ aspectRatio: '4 / 3', width: '100%', borderRadius: 16 }}
        />
        <div style={{ ...ui.stack, gap: 18, minWidth: 0 }}>
          <header style={{ ...ui.stack, gap: 6 }}>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 650,
                letterSpacing: '-0.03em',
                lineHeight: 1.2,
                color: palette.ink.strong,
                wordBreak: 'break-word',
              }}
            >
              {body.title}
            </h1>
            <strong
              style={{
                fontSize: 22,
                fontWeight: 650,
                color: isFree(body.price) ? palette.accent.good : palette.ink.strong,
              }}
            >
              {priceLabel(body.price)}
            </strong>
            <span style={{ fontSize: 13, color: palette.ink.muted }}>
              Listed {ago(record.createdAt)}
              {placeLabel(body.place) ? ` in ${placeLabel(body.place)}` : ''}
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {body.status && body.status !== 'available' && (
                <span style={{ ...styles.badge, color: palette.ink.strong, fontWeight: 600 }}>
                  {body.status === 'sold' ? 'Sold' : 'Reserved'}
                </span>
              )}
              <span style={styles.badge}>
                {cat.emoji} {cat.label}
              </span>
              {condition && <span style={styles.badge}>{condition.label}</span>}
            </div>
          </header>

          {selling ? (
            space.writable && (
              <div style={{ ...ui.stack, gap: 10 }}>
                <div role="group" aria-label="Status" className="segmented" style={{ alignSelf: 'stretch' }}>
                  {(['available', 'reserved', 'sold'] as const).map((s) => (
                    <button
                      key={s}
                      aria-selected={(body.status ?? 'available') === s}
                      onClick={() => setStatus(s)}
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      {s === 'available' ? 'Available' : s === 'reserved' ? 'Reserved' : 'Sold'}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={onEdit} data-variant="quiet" style={{ ...styles.smallButton, flex: 1 }}>
                    Edit listing
                  </button>
                  <button
                    onClick={() => {
                      if (!confirmDelete) return setConfirmDelete(true);
                      onBack();
                      void node.records.delete(space.id, record.key);
                    }}
                    onBlur={() => setConfirmDelete(false)}
                    data-variant="danger"
                    style={{ ...styles.smallButton, flex: 1, color: palette.accent.danger }}
                  >
                    {confirmDelete ? 'Delete for everyone?' : 'Delete'}
                  </button>
                </div>
              </div>
            )
          ) : (
            <Ask space={space} record={record} />
          )}

          <SellerCard did={record.createdBy} />

          {body.description && (
            <section style={{ ...ui.stack, gap: 8 }}>
              <h3 style={styles.sectionTitle}>Details</h3>
              <p
                style={{
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: palette.ink.body,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {body.description}
              </p>
            </section>
          )}
        </div>
      </div>

      {selling && <Requests space={space} record={record} />}

      <div style={{ maxWidth: 640 }}>
        <Comments
          space={space}
          target={record.key}
          targetAuthor={record.root}
          comments={record.included.comments}
        />
      </div>
    </div>
  );
}

/** Asking the seller for it, and then where that stands */
function Ask({ space, record }: { space: AppProps['space']; record: ListingRecord }) {
  const node = useNode();
  const { did: me } = useAccount();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState('Hi! Is this still available?');
  const [busy, setBusy] = useState(false);
  const mine = myRequest(record, me);
  const body = record.body;

  if (mine) {
    const state = answerTo(mine, record);
    const said: Record<Answer, { title: string; text: string; tone: string }> = {
      waiting: {
        title: 'Request sent',
        text: 'The seller will see it and answer here.',
        tone: palette.surface.sunken,
      },
      accepted: {
        title: "It's yours if you want it",
        text: 'The seller accepted. Agree on pickup in the questions below, or in chat.',
        tone: '#ecf8ef',
      },
      declined: {
        title: 'The seller said no this time',
        text: 'It may have gone to someone else.',
        tone: palette.accent.dangerSoft,
      },
    };
    return (
      <div style={{ ...ui.stack, gap: 6, padding: 14, borderRadius: 12, background: said[state].tone }}>
        <strong style={{ fontSize: 14, color: palette.ink.strong }}>{said[state].title}</strong>
        <span style={{ fontSize: 13, color: palette.ink.muted }}>{said[state].text}</span>
        {mine.body.note && (
          <span style={{ fontSize: 13, color: palette.ink.body, fontStyle: 'italic' }}>
            “{mine.body.note}”
          </span>
        )}
        {space.writable && (
          <button
            onClick={() => void node.records.delete(space.id, mine.key)}
            data-variant="quiet"
            style={{ ...styles.smallButton, alignSelf: 'flex-start', marginTop: 4 }}
          >
            Withdraw request
          </button>
        )}
      </div>
    );
  }

  if (!space.writable) return null;
  if (body.status === 'sold') {
    return <p style={{ fontSize: 14, color: palette.ink.muted }}>This has been sold.</p>;
  }
  if (!writing) {
    return (
      <button
        onClick={() => setWriting(true)}
        data-variant="primary"
        style={{ ...styles.button, height: 44 }}
      >
        {isFree(body.price) ? 'I’d like this' : `Ask to buy · ${priceLabel(body.price)}`}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void node.records
          .put(
            space.id,
            order,
            {
              items: [{ title: body.title, quantity: 1, ...(body.price ? { price: body.price } : {}) }],
              ...(body.price ? { total: body.price } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
              ...respondingTo(record.root, me),
            },
            { links: [{ rel: 'about', to: record.key }] },
          )
          .finally(() => {
            setBusy(false);
            setWriting(false);
          });
      }}
      style={{
        ...ui.stack,
        gap: 8,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${palette.surface.line}`,
      }}
    >
      <label style={{ ...styles.fieldLabel, margin: 0 }} htmlFor="mk-note">
        A message to the seller
      </label>
      <textarea
        id="mk-note"
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={2000}
        style={{ ...styles.input, height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.5 }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => setWriting(false)}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          data-variant="primary"
          style={{ ...styles.addButton, height: 32 }}
        >
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
    </form>
  );
}

/** For the seller: who asked, and an answer to each */
function Requests({ space, record }: { space: AppProps['space']; record: ListingRecord }) {
  const node = useNode();
  const { did: me } = useAccount();
  const requests = [...record.included.requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (requests.length === 0) return null;

  const reply = async (request: Request, status: 'accepted' | 'cancelled') => {
    await node.records.put(
      space.id,
      orderUpdate,
      { status, ...respondingTo(request.root, me) },
      { links: [{ rel: 'about', to: request.key }] },
    );
    // Accepting one holds the thing for that person.
    if (status === 'accepted' && (record.body.status ?? 'available') === 'available') {
      await node.records.update(space.id, record.key, { ...record.body, status: 'reserved' });
    }
  };

  return (
    <section style={{ ...ui.stack, gap: 10 }}>
      <h3 style={styles.sectionTitle}>
        Requests <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{requests.length}</span>
      </h3>
      <div style={{ ...ui.card, overflow: 'hidden' }}>
        {requests.map((r, i) => {
          const state = answerTo(r, record);
          return (
            <div
              key={r.key}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: 14,
                borderTop: i ? `1px solid ${palette.surface.line}` : undefined,
              }}
            >
              <Avatar did={r.root ?? r.author} size={32} />
              <div style={{ ...ui.stack, gap: 4, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14 }}>
                  <Person did={r.root} style={{ fontWeight: 600, color: palette.ink.strong }} />
                  <span style={{ color: palette.ink.faint }}> · {ago(r.createdAt)}</span>
                </span>
                {r.body.note && (
                  <p
                    style={{
                      fontSize: 14,
                      color: palette.ink.body,
                      lineHeight: 1.5,
                      wordBreak: 'break-word',
                    }}
                  >
                    {r.body.note}
                  </p>
                )}
              </div>
              {state === 'waiting' && space.writable ? (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => void reply(r, 'cancelled')}
                    data-variant="quiet"
                    style={styles.smallButton}
                  >
                    Decline
                  </button>
                  <button onClick={() => void reply(r, 'accepted')} style={styles.darkSmall}>
                    Accept
                  </button>
                </div>
              ) : (
                <span
                  style={{
                    ...styles.badge,
                    flexShrink: 0,
                    color: state === 'accepted' ? palette.accent.good : palette.ink.muted,
                  }}
                >
                  {state === 'accepted' ? 'Accepted' : state === 'declined' ? 'Declined' : 'Waiting'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SellerCard({ did }: { did: string | null }) {
  if (!did) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${palette.surface.line}`,
      }}
    >
      <Avatar did={did} size={40} />
      <span style={{ ...ui.stack, gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 12, color: palette.ink.faint }}>Seller</span>
        <Person did={did} style={{ fontSize: 15, fontWeight: 600, color: palette.ink.strong }} />
      </span>
    </div>
  );
}

/** Putting something up for sale, or changing it */
function ListingForm({
  initial,
  onSave,
  onClose,
}: {
  initial: ListingRecord | null;
  onSave: (body: Listing) => Promise<void>;
  onClose: () => void;
}) {
  const was = initial?.body;
  const [title, setTitle] = useState(was?.title ?? '');
  const [category, setCategory] = useState(was ? kindOf(CATEGORIES, was.category).id : '');
  const [condition, setCondition] = useState<string>(was?.condition ?? '');
  const [amount, setAmount] = useState(was?.price?.amount ?? '');
  const [currency, setCurrency] = useState(was?.price?.currency ?? lastCurrency());
  const [locality, setLocality] = useState(was?.place?.address?.locality ?? was?.place?.name ?? '');
  const [description, setDescription] = useState(was?.description ?? '');
  const [busy, setBusy] = useState(false);

  const price = amount.trim().replace(',', '.');
  const badPrice = !!price && !/^\d{1,9}(\.\d{1,2})?$/.test(price);
  const ready = !!title.trim() && !!category && !badPrice;
  const chosenCondition = CONDITIONS.find((c) => c.id === condition)?.id;

  return (
    <Modal title={initial ? 'Edit listing' : 'Sell something'} onClose={onClose} width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          rememberCurrency(currency);
          void onSave({
            ...(was?.images ? { images: was.images } : {}),
            title: title.trim(),
            category,
            ...(price && Number(price) > 0 ? { price: { amount: price, currency } } : {}),
            ...(chosenCondition ? { condition: chosenCondition } : {}),
            ...(locality.trim() ? { place: { address: { locality: locality.trim() } } } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            status: was?.status ?? 'available',
          }).finally(() => setBusy(false));
        }}
        style={{ ...ui.stack, gap: 14 }}
      >
        <Field label="What are you selling?">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Oak dining table, seats six"
            maxLength={300}
            style={styles.input}
          />
        </Field>
        <Field label="Price">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0 or empty for free"
              inputMode="decimal"
              style={{ ...styles.input, flex: 1, minWidth: 0 }}
            />
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label="Currency"
              style={{ ...styles.input, width: 'auto' }}
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </Field>
        {badPrice && <p style={styles.error}>A price is a number, like 120 or 49.50.</p>}
        <Field label="Category">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => setCategory(c.id)}
                style={{ ...ui.chip, height: 30, ...(category === c.id ? ui.chipOn : {}) }}
              >
                <span aria-hidden>{c.emoji}</span> {c.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Condition">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CONDITIONS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={condition === c.id}
                onClick={() => setCondition(condition === c.id ? '' : c.id)}
                style={{ ...ui.chip, height: 30, ...(condition === c.id ? ui.chipOn : {}) }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Where to pick it up">
          <input
            value={locality}
            onChange={(e) => setLocality(e.target.value)}
            placeholder="Neighbourhood or town"
            maxLength={200}
            style={styles.input}
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Size, age, any marks, why you're selling"
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
            {busy ? 'Saving…' : initial ? 'Save' : 'Publish'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} style={{ ...ui.stack, gap: 6 }}>
      <span style={{ ...styles.fieldLabel, margin: 0 }}>{label}</span>
      {children}
    </div>
  );
}

/** The person's own request for a listing, if they made one */
const myRequest = (record: ListingRecord, me: string): Request | undefined =>
  record.included.requests.find((r) => (r.root ?? r.author) === me);

/**
 * Where a request stands: the seller's latest answer to it. Anyone in the
 * space could write an update about someone's order, so only the seller's
 * count.
 */
function answerTo(request: Request, record: ListingRecord): Answer {
  const latest = request.included.updates
    .filter((u) => u.root !== null && u.root === (record.createdBy ?? record.root))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return 'waiting';
  return latest.body.status === 'cancelled' || latest.body.status === 'refunded' ? 'declined' : 'accepted';
}

const isFree = (price: Money | undefined) => !price || Number(price.amount) === 0;

/** A price as people read it: "€120", "kr 450", or Free */
function priceLabel(price: Money | undefined): string {
  if (isFree(price) || !price) return 'Free';
  const value = Number(price.amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

/** For sorting by price; currencies are compared as plain numbers */
const priceOf = (record: ListingRecord) => Number(record.body.price?.amount ?? 0);

const sortOf = (value: string): Sort => (value === 'cheap' || value === 'dear' ? value : 'new');

function placeLabel(place: Listing['place']): string {
  if (!place) return '';
  return [place.name, place.address?.locality].filter(Boolean).join(', ');
}

/** The currency this person last priced something in, so they don't pick it every time */
function lastCurrency(): string {
  try {
    return globalThis.localStorage.getItem('weave:market-currency') ?? 'EUR';
  } catch {
    return 'EUR';
  }
}
function rememberCurrency(currency: string) {
  try {
    globalThis.localStorage.setItem('weave:market-currency', currency);
  } catch {
    // Private windows can refuse; picking it again is all that costs.
  }
}

const bare: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
};
const backLink: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 13,
  fontWeight: 500,
  color: palette.ink.muted,
};
const pill: CSSProperties = {
  padding: '3px 9px',
  borderRadius: 999,
  background: 'rgba(255, 255, 255, .92)',
  color: palette.ink.strong,
  fontSize: 12,
  fontWeight: 600,
  boxShadow: '0 2px 8px -4px rgba(0, 0, 0, .3)',
};
