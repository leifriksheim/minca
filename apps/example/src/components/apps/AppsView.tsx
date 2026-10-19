import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import type { NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/core/react';
import type { AppEntry, useSpaceApps } from './entries';
import { AppIcon, Count } from './AppIcon';
import { Proposals } from './MadeApps';
import { moveApp, removeApp } from './launcher';
import { Icon } from '../Icon';
import { unreadOf, type Unread } from '../../seen';
import { styles, palette, variants } from '../../styles';
import { ask } from '@minca/app-shared/Ask';

/**
 * A space's apps like a phone's home screen: those added, then proposals.
 * Ready-made ones to add are under New app (`NewApp`). Someone who may add collections can arrange them: move
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
  const [arranging, setArranging] = useState(false);
  const arrange = useAction();

  const move = (app: AppEntry, by: number) => {
    const at = apps.placed.findIndex((record) => record.key === app.record.key);
    void arrange.run(() => moveApp(node, space.id, apps.placed, app.record.key, at + by));
  };
  const remove = async (app: AppEntry) => {
    const sure = await ask(
      app.builtIn
        ? 'Everything it holds stays in the space, and adding it again brings it back.'
        : 'Everything it holds stays in the space; to have the app again, someone proposes it again.',
      { title: `Take ${app.title} off ${space.name}?`, yes: 'Take it off', danger: true },
    );
    if (sure) await arrange.run(() => removeApp(node, space.id, app.record, apps.records));
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
                <Icon name="plus" size={14} /> New app
              </button>
            )}
          </div>
        </div>

        {/* Arranging is a list on every screen: one app to a row, its moves at the end, where a thumb finds them. */}
        {arranging ? (
          <ol aria-label="Arrange apps" style={arrangeList}>
            {apps.ready.map((app, at) => (
              <ArrangeRow
                key={app.id}
                app={app}
                busy={arrange.busy}
                first={at === 0}
                last={at === apps.ready.length - 1}
                onMove={(by) => move(app, by)}
                onRemove={() => void remove(app)}
              />
            ))}
          </ol>
        ) : (
          <div className="app-grid">
            {apps.ready.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                unread={unreadOf(unread, app.id)}
                onClick={() => onOpenApp(app.id)}
              />
            ))}
            {space.writable && (
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
                  <strong style={cardTitle}>New app</strong>
                  <span className="app-card-text" style={cardText}>
                    Add a ready-made one, or have an agent build your own
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
        {arrange.error && <p style={styles.error}>{arrange.error}</p>}
        {apps.ready.length === 0 && (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>
            No apps here yet. Add a ready-made one, or have an agent build your own.
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

      {/* On a phone the button in the heading gives way to one under the thumb, once
          there are apps; before that the tile in the grid is the way. */}
      {space.writable && apps.ready.length > 0 && !arranging && (
        <button onClick={onCreate} data-variant="primary" className="fab">
          <Icon name="plus" size={16} /> New app
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

/** An app while the apps are being arranged: moved up or down the list, or taken off */
function ArrangeRow({
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
    <li style={{ ...arrangeRow, borderTop: first ? 'none' : `1px solid ${palette.surface.line}` }}>
      <AppIcon id={app.id} size={32} />
      <strong style={{ ...cardTitle, ...ellipsis, flex: 1, minWidth: 0 }}>{app.title}</strong>
      <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button
          onClick={() => onMove(-1)}
          disabled={busy || first}
          aria-label={`Move ${app.title} up`}
          data-variant="quiet"
          style={roundButton}
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
            <Icon name="chevron" size={14} />
          </span>
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={busy || last}
          aria-label={`Move ${app.title} down`}
          data-variant="quiet"
          style={roundButton}
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
            <Icon name="chevron" size={14} />
          </span>
        </button>
        <button
          onClick={onRemove}
          disabled={busy}
          data-variant="quiet"
          style={{ ...styles.smallButton, height: 40, color: palette.accent.danger }}
        >
          Remove
        </button>
      </span>
    </li>
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
  ...styles.tile,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: 14,
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
const arrangeList = {
  listStyle: 'none',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 560,
  border: `1px solid ${palette.surface.rule}`,
  borderRadius: palette.radius.lg,
  background: palette.surface.card,
  overflow: 'hidden',
} as const;
const arrangeRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 56,
  padding: '8px 10px 8px 14px',
} as const;
// As tall as a finger needs (`pointer: coarse` raises buttons to 40), and as wide, so they stay round.
const roundButton = { ...styles.smallButton, width: 40, height: 40, padding: 0, flexShrink: 0 } as const;
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const cardTitle = { fontSize: 15, fontWeight: 600, color: palette.ink.strong };
const cardText = { fontSize: 13, lineHeight: 1.45, color: palette.ink.muted };
const inlineButton = {
  width: 'auto',
  height: 36,
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
} as const;
