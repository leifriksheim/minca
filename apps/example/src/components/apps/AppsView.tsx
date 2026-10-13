import { useState } from 'react';
import { useAction } from '@weave/app-shared/action';
import type { NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useNode } from '@weaveprotocol/core/react';
import { has, type WeaveApp } from './index';
import type { AppEntry, useSpaceApps } from './entries';
import { AppIcon, Count } from './AppIcon';
import { Proposals } from './MadeApps';
import { addBuiltIn, moveApp, removeApp } from './launcher';
import { Icon } from '../Icon';
import { unreadOf, type Unread } from '../../seen';
import { styles, palette, variants } from '../../styles';

/**
 * A space's apps like a phone's home screen: those added, then proposals and
 * built-ins to add. Someone who may add collections can arrange them: move
 * them, or take them off. Taking one off keeps everything it holds.
 */
export function AppsView({
  space,
  collections,
  apps,
  unread,
  mayDefine,
  onOpenApp,
  onCreate,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  apps: ReturnType<typeof useSpaceApps>;
  unread: ReadonlyMap<string, Unread>;
  mayDefine: boolean;
  onOpenApp: (id: string) => void;
  onCreate: () => void;
}) {
  const node = useNode();
  const [adding, setAdding] = useState<WeaveApp | null>(null);
  const [arranging, setArranging] = useState(false);
  const { run, busy, error } = useAction();
  const arrange = useAction();

  const add = (app: WeaveApp) => {
    setAdding(app);
    void run(async () => {
      await addBuiltIn(node, space.id, app, apps.placed);
      onOpenApp(app.id);
    });
  };
  const move = (app: AppEntry, by: number) => {
    const at = apps.placed.findIndex((record) => record.key === app.record.key);
    void arrange.run(() => moveApp(node, space.id, apps.placed, app.record.key, at + by));
  };
  const remove = (app: AppEntry) => {
    const sure = globalThis.confirm(
      app.builtIn
        ? `Take ${app.title} off ${space.name}? Everything it holds stays in the space, and adding it again brings it back.`
        : `Take ${app.title} off ${space.name}? Everything it holds stays in the space; to have the app again, someone proposes it again.`,
    );
    if (sure) void arrange.run(() => removeApp(node, space.id, app.record, apps.records));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <section aria-label="Apps in this space" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Apps</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
              What you use together here. Everything they save stays in the space.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {mayDefine && apps.ready.length > 0 && (
              <button
                onClick={() => setArranging((was) => !was)}
                aria-pressed={arranging}
                data-variant={arranging ? 'primary' : 'quiet'}
                style={{ ...(arranging ? styles.button : variants.quiet), ...inlineButton }}
              >
                {arranging ? 'Done' : 'Arrange'}
              </button>
            )}
            {space.writable && !arranging && (
              <button
                onClick={onCreate}
                data-variant="primary"
                className="hide-on-phone"
                style={{ ...styles.button, ...inlineButton }}
              >
                <Icon name="sparkle" size={14} /> Create an app
              </button>
            )}
          </div>
        </div>

        <div className="app-grid">
          {apps.ready.map((app, at) =>
            arranging ? (
              <ArrangeCard
                key={app.id}
                app={app}
                busy={arrange.busy}
                first={at === 0}
                last={at === apps.ready.length - 1}
                onMove={(by) => move(app, by)}
                onRemove={() => remove(app)}
              />
            ) : (
              <AppCard
                key={app.id}
                app={app}
                unread={unreadOf(unread, app.id)}
                onClick={() => onOpenApp(app.id)}
              />
            ),
          )}
          {space.writable && !arranging && (
            <button onClick={onCreate} data-tile-new className="app-card" style={createCard}>
              <span
                className="app-card-icon"
                style={{
                  ...iconBox,
                  border: `1px dashed ${palette.surface.lineStrong}`,
                  color: palette.ink.muted,
                }}
              >
                <Icon name="plus" size={20} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <strong style={cardTitle}>Create an app</strong>
                <span className="app-card-text" style={cardText}>
                  Describe it, and an agent builds it for this space
                </span>
              </span>
            </button>
          )}
        </div>
        {arrange.error && <p style={styles.error}>{arrange.error}</p>}
        {apps.ready.length === 0 && (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>
            No apps here yet. Add a ready-made one below, or create your own.
          </p>
        )}
      </section>

      <Proposals
        space={space}
        proposals={apps.proposed}
        placed={apps.placed}
        collections={collections}
        mayDefine={mayDefine}
        onAdded={(key) => onOpenApp(`made:${key}`)}
      />

      {apps.addable.length > 0 && (
        <section aria-label="More apps" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <h2 style={styles.sectionTitle}>More apps</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
              {mayDefine
                ? 'Ready-made. Adding one adds every collection it uses, which hold ordinary records.'
                : 'Someone whose role lets them add collections can add these.'}
            </p>
          </div>
          <div className="app-list">
            {apps.addable.map((app) => (
              <div key={app.id} style={addRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <AppIcon id={app.id} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={cardTitle}>{app.title}</strong>
                    <p style={cardText}>{app.description}</p>
                  </div>
                  {mayDefine && (
                    <button
                      onClick={() => add(app)}
                      disabled={busy}
                      aria-label={`Add ${app.title}`}
                      data-variant="quiet"
                      style={{ ...styles.smallButton, flexShrink: 0 }}
                    >
                      {busy && adding?.id === app.id ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: palette.ink.faint, paddingLeft: 52 }}>
                    What it stores
                  </summary>
                  <SchemaList app={app} collections={collections} />
                </details>
              </div>
            ))}
          </div>
          {error && (
            <p style={styles.error}>
              Could not add {adding?.title}: {error}
            </p>
          )}
        </section>
      )}

      {/* On a phone the button in the heading gives way to one under the thumb, once
          there are apps; before that the tile in the grid is the way. */}
      {space.writable && apps.ready.length > 0 && (
        <button onClick={onCreate} data-variant="primary" className="fab">
          <Icon name="sparkle" size={16} /> Create an app
        </button>
      )}
    </div>
  );
}

/** An app on the home screen: its icon, its name, a line on what it's for, and what's new in it */
function AppCard({ app, unread, onClick }: { app: AppEntry; unread: Unread; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-tile
      className="app-card"
      data-unread={unread.count > 0 || undefined}
      style={card}
    >
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <AppIcon id={app.id} size={44} className="app-card-icon" />
        <span className="app-card-count">
          <Count unread={unread} />
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <strong style={cardTitle}>{app.title}</strong>
        {app.description && (
          <span className="app-card-text" style={cardText}>
            {app.description}
          </span>
        )}
      </span>
    </button>
  );
}

/** An app on the home screen while it is being arranged: moved earlier or later, or taken off */
function ArrangeCard({
  app,
  busy,
  first,
  last,
  onMove,
  onRemove,
}: {
  app: AppEntry;
  busy: boolean;
  first: boolean;
  last: boolean;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="app-card" data-arranging style={{ ...card, alignItems: 'center' }}>
      <AppIcon id={app.id} size={44} className="app-card-icon" />
      <strong style={{ ...cardTitle, flex: 1, minWidth: 0 }}>{app.title}</strong>
      <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => onMove(-1)}
          disabled={busy || first}
          aria-label={`Move ${app.title} earlier`}
          data-variant="quiet"
          style={{ ...styles.smallButton, width: 32, padding: 0 }}
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon name="chevron" size={12} />
          </span>
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={busy || last}
          aria-label={`Move ${app.title} later`}
          data-variant="quiet"
          style={{ ...styles.smallButton, width: 32, padding: 0 }}
        >
          <Icon name="chevron" size={12} />
        </button>
        <button
          onClick={onRemove}
          disabled={busy}
          data-variant="quiet"
          style={{ ...styles.smallButton, color: palette.accent.danger }}
        >
          Remove
        </button>
      </span>
    </div>
  );
}

/** What an app reads and writes, and whether this space has each yet */
function SchemaList({ app, collections }: { app: WeaveApp; collections: ReadonlyArray<NodeCollection> }) {
  const rows = [
    ...app.needs.map((s) => ({ s, optional: false })),
    ...(app.uses ?? []).map((s) => ({ s, optional: true })),
  ];
  return (
    <ul
      style={{
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        marginTop: 8,
        paddingTop: 8,
        borderTop: `1px solid ${palette.surface.line}`,
      }}
    >
      {rows.map(({ s, optional }) => {
        const here = has(collections, s.name);
        return (
          <li
            key={s.name}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 12,
            }}
          >
            <span style={{ color: palette.ink.body }}>
              {s.title} <code style={{ fontSize: 11, color: palette.ink.faint }}>{s.name}</code>
            </span>
            <span style={{ color: here ? palette.accent.good : palette.ink.faint, whiteSpace: 'nowrap' }}>
              {here ? 'in this space' : optional ? 'will be added, for when it is used' : 'will be added'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const iconBox = {
  width: 44,
  height: 44,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: palette.radius.lg,
} as const;

const card = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: palette.radius.lg,
  background: palette.surface.card,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
} as const;
const createCard = {
  ...card,
  borderStyle: 'dashed',
  borderColor: palette.surface.lineStrong,
  background: 'none',
} as const;
const cardTitle = { fontSize: 15, fontWeight: 600, color: palette.ink.strong };
const cardText = { fontSize: 13, lineHeight: 1.45, color: palette.ink.muted };
const addRow = {
  padding: 12,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: palette.radius.lg,
  background: palette.surface.card,
} as const;
const inlineButton = {
  width: 'auto',
  height: 36,
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
} as const;
