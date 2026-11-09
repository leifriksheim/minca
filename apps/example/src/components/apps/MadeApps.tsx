import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import { describeCollection, type NodeCollection, type NodeRecord, type SpaceSummary } from '@minca/core';
import { useLive, useNode } from '@minca/react';
import {
  blueprint as blueprintSchema,
  reviewBlueprint,
  type Blueprint,
  type BlueprintReview,
} from '@minca/core/schemas';
import { AppBoard } from './AppBoard';
import {
  addMade,
  checkLauncherApp,
  isDirect,
  removeApp,
  settingsOf,
  updated,
  type LauncherApp,
} from './launcher';
import { DirectMessages } from './DirectMessages';
import { Sheets } from './Sheets';
import { isSheets } from './sheet-views';
import { ScreenFrame } from './ScreenFrame';
import { ago } from '@minca/ui/time';
import { Person } from '../Person';
import styles from './MadeApps.module.css';
import { confirmThen } from '../../confirm';
import { Info } from '@minca/app-shared/Info';

/**
 * The blueprint a proposed app points at, if any, and what applying it would
 * do: worked out from its rules rather than its words.
 */
function useBlueprintReview(
  space: SpaceSummary,
  record: NodeRecord<LauncherApp>,
  collections: ReadonlyArray<NodeCollection>,
): { readonly plan: Blueprint | null; readonly review: BlueprintReview | null } {
  const key = record.links.find((link) => link.rel === 'blueprint')?.to;
  const blueprints = useLive(
    space.id,
    async (node) => (key ? node.records.list<Blueprint>(space.id, { collection: blueprintSchema.name }) : []),
    [space.id, key],
  );
  const found = blueprints?.find((one) => one.key === key);
  if (!found?.body) return { plan: null, review: null };
  return {
    plan: found.body,
    review: reviewBlueprint(found.body, collections, { blueprints: blueprints ?? [], key: found.key }),
  };
}

/** Proposals waiting for someone to add them */
export function Proposals({
  space,
  proposals,
  placed,
  collections,
  mayDefine,
  onAdded,
}: {
  space: SpaceSummary;
  proposals: ReadonlyArray<NodeRecord<LauncherApp>>;
  /** The apps on the launcher, to name the one an update replaces and to place the new one after */
  placed: ReadonlyArray<NodeRecord<LauncherApp>>;
  collections: ReadonlyArray<NodeCollection>;
  mayDefine: boolean;
  onAdded: (key: string) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <section aria-label="Proposed apps">
      <h2>
        Proposed
        <Info label="About proposed apps">
          Apps someone, or their agent, made for this space. Nothing changes until someone who can add
          collections adds one. What each allows is worked out from its rules, not from what its author says
          about it.
        </Info>
      </h2>
      <div className="stack">
        {proposals.map((record) => (
          <Proposal
            key={record.key}
            space={space}
            record={record}
            replaces={updated(record, placed)}
            placed={placed}
            collections={collections}
            mayDefine={mayDefine}
            onAdded={onAdded}
          />
        ))}
      </div>
    </section>
  );
}

function Proposal({
  space,
  record,
  replaces,
  placed,
  collections,
  mayDefine,
  onAdded,
}: {
  space: SpaceSummary;
  record: NodeRecord<LauncherApp>;
  replaces: NodeRecord<LauncherApp> | undefined;
  placed: ReadonlyArray<NodeRecord<LauncherApp>>;
  collections: ReadonlyArray<NodeCollection>;
  mayDefine: boolean;
  onAdded: (key: string) => void;
}) {
  const node = useNode();
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState(false);
  const body = record.body;
  const { plan, review } = useBlueprintReview(space, record, collections);
  // Collections it shows that neither the space nor its blueprint has: adding it would leave them missing.
  const missing = (body?.collections ?? []).filter(
    (name) =>
      !collections.some((c) => c.name === name && c.version !== null) &&
      !plan?.collections.some((c) => c.name === name),
  );
  const problem =
    (body ? checkLauncherApp(body) : null) ??
    review?.problem ??
    (missing.length ? `the space has no ${missing.join(' or ')}` : null);
  // What it shows that the space has already, which its blueprint doesn't cover: listed too, so nothing it can write is unseen.
  const alsoShows = (body?.collections ?? []).flatMap((name) => {
    if (plan?.collections.some((c) => c.name === name)) return [];
    const held = collections.find((c) => c.name === name && c.version !== null);
    return held ? [held] : [];
  });
  // Written by someone other than whoever made it: what is proposed now is theirs.
  const by = record.root ?? record.createdBy;
  // It was on the launcher once: someone changed it since, or whoever added it can't add collections now.
  const wasAdded = body?.position !== undefined;
  const mine = by === node.did;

  const add = () =>
    run(async () => {
      onAdded(await addMade(node, space.id, record, placed));
    });
  const remove = () => {
    const title = body?.title ?? 'this app';
    confirmThen(
      mine ? 'Your proposal is taken back.' : 'It is removed for everyone.',
      { title: mine ? `Withdraw ${title}?` : `Decline ${title}?`, yes: mine ? 'Withdraw' : 'Decline' },
      () => run(() => removeApp(node, space.id, record, [record])),
    );
  };

  const changes = review?.collections.filter((one) => one.status === 'change') ?? [];
  // Every collection it can write, each with what it allows: its blueprint's, then those the space has already.
  const reviewed = [
    ...(review?.collections ?? []),
    ...alsoShows.map((held) => ({
      definition: { name: held.name, ...(held.title !== undefined ? { title: held.title } : {}) },
      status: 'same' as const,
      summary: describeCollection({ ...held, schema: held.schema ?? undefined }),
      changes: [],
      usedBy: [],
    })),
  ];

  return (
    <article>
      <header>
        <div>
          <strong>{body?.title ?? 'An app that could not be read'}</strong>
          <p>
            <small>
              {wasAdded ? 'Changed by' : 'Proposed by'} <Person did={by} />
              {record.recordsOnly && <AgentBadge />} · {ago(record.updatedAt)}
              {plan?.from && ' · copied from another space'}
              {replaces?.body && ` · an update to ${replaces.body.title}`}
              {body?.updates !== undefined &&
                !replaces &&
                ' · an update to an app no longer here; adding it adds it as its own'}
            </small>
          </p>
        </div>
        {mine && (
          <button type="button" data-intent="ghost" onClick={remove} disabled={busy}>
            Withdraw
          </button>
        )}
        {mayDefine && !mine && (
          <button type="button" data-intent="ghost" onClick={remove} disabled={busy}>
            Decline
          </button>
        )}
        {mayDefine && body && !problem && (
          <button
            type="button"
            data-intent="primary"
            onClick={() => void add()}
            disabled={busy}
            aria-label={`Add ${body?.title}`}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        )}
      </header>

      {body?.description && (
        <p>
          <small>What they say it's for: </small>“{body.description}”
        </p>
      )}

      {problem && <p role="alert">This can't be added: {problem}</p>}

      {body?.screen && <ScreenNote screen={body.screen} network={body.network ?? []} />}

      {!problem && reviewed.length > 0 && (
        <>
          {changes.length > 0 && (
            <p role="alert">
              It changes{' '}
              {changes
                .map(
                  (c) =>
                    collections.find((held) => held.name === c.definition.name)?.title ?? c.definition.name,
                )
                .join(' and ')}
              , which this space already has: {changes.map((c) => c.changes.join(', ')).join('; ')}.
              {changes
                .filter((c) => c.usedBy.length)
                .map(
                  (c) =>
                    ` ${c.usedBy.join(' and ')} ${c.usedBy.length > 1 ? 'use' : 'uses'} it as it is now.`,
                )
                .join('')}
            </p>
          )}
          {body?.shows?.length ? (
            // What opens here is what it learns the person opens, from anywhere in the space.
            <p>
              {body.shows
                .map((name) => {
                  // `std.list:tab`: the lists of one kind
                  const [shown = name, kind] = name.split(':');
                  const title = collections.find((c) => c.name === shown)?.title ?? shown;
                  return kind ? `${title} (${kind})` : title;
                })
                .join(', ')}{' '}
              opened anywhere in {space.name} can open here.
            </p>
          ) : null}
          <button type="button" data-intent="inline" onClick={() => setOpen((was) => !was)}>
            {open
              ? 'Hide what it allows'
              : `What it allows (${reviewed.length} ${reviewed.length === 1 ? 'collection' : 'collections'})`}
          </button>
          {open && (
            <ul role="list">
              {reviewed.map((need) => (
                <li key={need.definition.name} className="stack" data-gap="tight">
                  <div className="row" data-spread>
                    <strong>
                      {need.definition.title ?? need.definition.name} <code>{need.definition.name}</code>
                    </strong>
                    <small
                      data-tone={
                        need.status === 'same' ? 'good' : need.status === 'change' ? 'danger' : undefined
                      }
                    >
                      {need.status === 'new' ? 'new' : need.status === 'same' ? 'already here' : 'changes it'}
                    </small>
                  </div>
                  <ul>
                    {need.summary.map((sentence) => (
                      <li key={sentence}>{sentence}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!mayDefine && !problem && <small>Someone whose role lets them add collections can add it.</small>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

/**
 * An app that brings its own screen. Code can't be summed up the way rules
 * can, so this says what the screen is able to do at all — which the frame
 * enforces — and shows the code for anyone who wants to read it.
 */
function ScreenNote({ screen, network }: { screen: string; network: ReadonlyArray<string> }) {
  const [open, setOpen] = useState(false);
  const kb = Math.max(1, Math.round(new TextEncoder().encode(screen).length / 1024));
  return (
    <aside className="stack">
      <p>
        <strong>It brings its own screen</strong> ({kb} KB of code). It runs sealed: it can read and change
        only this app's records, in this space, as whoever is looking — under the rules below.{' '}
        {network.length ? (
          <>
            It can also connect to{' '}
            <strong>{network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ')}</strong>, and
            send there anything the person looking can see in it. Adding it allows that for everyone here;
            nothing else on the internet is reachable.
          </>
        ) : (
          <>It can't reach the internet or anything else in the app.</>
        )}{' '}
        The rules below can't vouch for what the screen shows, so add it only if you trust whoever proposed
        it.
      </p>
      <button type="button" data-intent="inline" onClick={() => setOpen((was) => !was)}>
        {open ? 'Hide the code' : 'Show the code'}
      </button>
      {open && <pre className={styles.code}>{screen}</pre>}
    </aside>
  );
}

/** "via agent", beside a name */
function AgentBadge() {
  return (
    <span
      className="tag"
      title="An agent wrote this for them. Their account said so when it let the agent in."
    >
      via agent
    </span>
  );
}

/** An added app: its own screen when its launcher record carries one, else its records. */
export function MadeAppScreen({
  space,
  record,
  collections,
  onOpen,
  shown,
  onShown,
  view,
  onGo,
}: {
  space: SpaceSummary;
  record: NodeRecord<LauncherApp>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  /** A record its screen was asked to show (`shows`), and what to do once it has been handed over */
  shown?: string | undefined;
  onShown?: () => void;
  /** Where in itself its screen is, and going somewhere else in it (`minca.go`) */
  view?: string | null;
  onGo?: (view: string | null, title: string | null) => void;
}) {
  const body = record.body!;
  const names = body.collections ?? [];
  const screen = body.screen;

  return (
    <section aria-label={body.title} className={styles.app}>
      {isDirect(body) ? (
        <DirectMessages space={space} shown={shown} onShown={onShown} view={view ?? null} onGo={onGo} />
      ) : isSheets(body) ? (
        <Sheets space={space} collections={collections} onOpen={onOpen} view={view ?? null} onGo={onGo} />
      ) : screen ? (
        <ScreenFrame
          spaceId={space.id}
          appKey={record.key}
          collections={names}
          screen={screen}
          network={body.network ?? []}
          settings={settingsOf(body)}
          title={body.title ?? 'An app'}
          onOpen={onOpen}
          shows={body.shows}
          shown={shown}
          onShown={onShown}
          view={view ?? null}
          onGo={onGo}
        />
      ) : (
        // The app fills the window edge to edge, so the lists bring their own margin and scroll.
        <div className={styles.board}>
          <AppBoard space={space} names={names} collections={collections} onOpen={onOpen} />
        </div>
      )}
    </section>
  );
}
