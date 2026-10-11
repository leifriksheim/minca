import { useState } from 'react';
import { message, useAction } from '@weave/app-shared/action';
import {
  describeCollection,
  type NodeCollection,
  type NodeRecord,
  type SpaceSummary,
} from '@weaveprotocol/core';
import { useLive, useNode, useSpaces } from '@weaveprotocol/core/react';
import {
  blueprint as blueprintSchema,
  reviewBlueprint,
  type Blueprint,
  type BlueprintReview,
} from '@weaveprotocol/core/schemas';
import { AppBoard } from './AppBoard';
import { addMade, copyApp, removeApp, updated, type LauncherApp } from './launcher';
import { ScreenFrame } from './ScreenFrame';
import { ago } from '../../derive/time';
import { styles, palette } from '../../styles';
import { Person } from '../Person';

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
    <section aria-label="Proposed apps" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h2 style={styles.sectionTitle}>Proposed</h2>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
          Apps someone, or their agent, made for this space. Nothing changes until someone who can add
          collections adds one. What each allows is worked out from its rules, not from what its author says
          about it.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
  const problem = review?.problem ?? (missing.length ? `the space has no ${missing.join(' or ')}` : null);
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
    const sure = globalThis.confirm(
      mine
        ? `Withdraw ${body?.title ?? 'this app'}?`
        : `Decline ${body?.title ?? 'this app'}? It is removed for everyone.`,
    );
    if (sure) void run(() => removeApp(node, space.id, record, [record]));
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
    <article style={{ ...tile, gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ ...tileTitle, fontSize: 15 }}>
            {body?.title ?? 'An app that could not be read'}
          </strong>
          <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 2 }}>
            {wasAdded ? 'Changed by' : 'Proposed by'} <Person did={by} />
            {record.recordsOnly && <AgentBadge />} · {ago(record.updatedAt)}
            {plan?.from && ' · copied from another space'}
            {replaces?.body && ` · an update to ${replaces.body.title}`}
            {body?.updates !== undefined &&
              !replaces &&
              ' · an update to an app no longer here; adding it adds it as its own'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {mine && (
            <button
              onClick={remove}
              disabled={busy}
              data-variant="quiet"
              style={{ ...styles.smallButton, height: 28 }}
            >
              Withdraw
            </button>
          )}
          {mayDefine && !mine && (
            <button
              onClick={remove}
              disabled={busy}
              data-variant="quiet"
              style={{ ...styles.smallButton, height: 28 }}
            >
              Decline
            </button>
          )}
          {mayDefine && body && !problem && (
            <button
              onClick={() => void add()}
              disabled={busy}
              data-variant="primary"
              style={{ ...styles.smallButton, height: 28 }}
              aria-label={`Add ${body?.title}`}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          )}
        </div>
      </header>

      {body?.description && (
        <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
          <span style={{ color: palette.ink.faint }}>What they say it's for: </span>“{body.description}”
        </p>
      )}

      {problem && <p style={styles.error}>This can't be added: {problem}</p>}

      {body?.screen && <ScreenNote screen={body.screen} network={body.network ?? []} />}

      {!problem && reviewed.length > 0 && (
        <>
          {changes.length > 0 && (
            <p style={{ fontSize: 13, color: palette.accent.danger, lineHeight: 1.5 }}>
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
          <button
            onClick={() => setOpen((was) => !was)}
            data-variant="ghost"
            style={{ ...styles.linkButton, alignSelf: 'flex-start', padding: 0, fontSize: 13 }}
          >
            {open
              ? 'Hide what it allows'
              : `What it allows (${reviewed.length} ${reviewed.length === 1 ? 'collection' : 'collections'})`}
          </button>
          {open && (
            <ul
              style={{
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                paddingTop: 10,
                borderTop: `1px solid ${palette.surface.line}`,
              }}
            >
              {reviewed.map((need) => (
                <li key={need.definition.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                    <span style={{ color: palette.ink.strong, fontWeight: 500 }}>
                      {need.definition.title ?? need.definition.name}{' '}
                      <code style={{ fontSize: 11, color: palette.ink.faint }}>{need.definition.name}</code>
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        color:
                          need.status === 'change'
                            ? palette.accent.danger
                            : need.status === 'same'
                              ? palette.accent.good
                              : palette.ink.faint,
                      }}
                    >
                      {need.status === 'new' ? 'new' : need.status === 'same' ? 'already here' : 'changes it'}
                    </span>
                  </div>
                  <ul
                    style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}
                  >
                    {need.summary.map((sentence) => (
                      <li key={sentence} style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.45 }}>
                        {sentence}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!mayDefine && !problem && (
        <p style={{ fontSize: 12, color: palette.ink.faint }}>
          Someone whose role lets them add collections can add it.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        background: palette.surface.sunken,
        borderRadius: 8,
      }}
    >
      <p style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.5 }}>
        <strong style={{ color: palette.ink.strong }}>It brings its own screen</strong> ({kb} KB of code). It
        runs sealed: it can read and change only this app's records, in this space, as whoever is looking —
        under the rules below.{' '}
        {network.length ? (
          <>
            It can also connect to{' '}
            <strong style={{ color: palette.ink.strong }}>
              {network.map((origin) => origin.replace(/^[a-z]+:\/\//, '')).join(', ')}
            </strong>
            , and send there anything the person looking can see in it. Each person is asked before their
            screen gets that; nothing else on the internet is reachable.
          </>
        ) : (
          <>It can't reach the internet or anything else in the app.</>
        )}{' '}
        The rules below can't vouch for what the screen shows, so add it only if you trust whoever proposed
        it.
      </p>
      <button
        onClick={() => setOpen((was) => !was)}
        data-variant="ghost"
        style={{ ...styles.linkButton, alignSelf: 'flex-start', padding: 0, fontSize: 13 }}
      >
        {open ? 'Hide the code' : 'Show the code'}
      </button>
      {open && (
        <pre
          style={{
            maxHeight: 280,
            overflow: 'auto',
            margin: 0,
            padding: 10,
            fontSize: 11,
            lineHeight: 1.45,
            background: palette.surface.card,
            border: `1px solid ${palette.surface.line}`,
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {screen}
        </pre>
      )}
    </div>
  );
}

/** "via agent", beside a name */
function AgentBadge() {
  return (
    <span
      title="An agent wrote this for them. Their account said so when it let the agent in."
      style={{
        marginLeft: 6,
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid ${palette.surface.line}`,
        fontSize: 11,
        color: palette.ink.muted,
      }}
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
}: {
  space: SpaceSummary;
  record: NodeRecord<LauncherApp>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}) {
  const body = record.body!;
  const names = body.collections ?? [];
  const screen = body.screen;
  const [plain, setPlain] = useState(false);
  const others = useSpaces().spaces.filter((other) => other.id !== space.id && other.writable);

  return (
    <section
      aria-label={body.title}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, flex: 1, minHeight: 0 }}
    >
      {(screen || others.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {screen && (
            <button
              onClick={() => setPlain((was) => !was)}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              {plain ? 'Show its screen' : 'Show the records'}
            </button>
          )}
          <CopyTo space={space} record={record} others={others} />
        </div>
      )}
      {screen && !plain ? (
        <ScreenFrame
          spaceId={space.id}
          appKey={record.key}
          collections={names}
          screen={screen}
          network={body.network ?? []}
          title={body.title ?? 'An app'}
        />
      ) : (
        <AppBoard space={space} names={names} collections={collections} onOpen={onOpen} />
      )}
    </section>
  );
}

/** Proposes the same app in another of your spaces — people there decide for themselves */
function CopyTo({
  space,
  record,
  others,
}: {
  space: SpaceSummary;
  record: NodeRecord<LauncherApp>;
  others: ReadonlyArray<SpaceSummary>;
}) {
  const node = useNode();
  const [said, setSaid] = useState<string | null>(null);
  if (others.length === 0) return null;
  return (
    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      {said && <span style={{ color: palette.ink.muted }}>{said}</span>}
      <select
        value=""
        aria-label="Copy to another space"
        onChange={(event) => {
          const target = others.find((other) => other.id === event.target.value);
          if (!target) return;
          setSaid(null);
          copyApp(node, space.id, record, target.id).then(
            () => setSaid(`Proposed in ${target.name}`),
            (e: unknown) => setSaid(message(e)),
          );
        }}
        style={{ ...styles.smallButton, height: 30 }}
      >
        <option value="">Copy to…</option>
        {others.map((other) => (
          <option key={other.id} value={other.id}>
            {other.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A proposal, as a card in the list of them */
const tile = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
  background: palette.surface.card,
  font: 'inherit',
  color: 'inherit',
};
const tileTitle = { fontSize: 14, fontWeight: 600, color: palette.ink.strong };
