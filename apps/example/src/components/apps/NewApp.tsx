import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import type { DefineCollection, NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import type { useSpaceApps } from './entries';
import { AppIcon } from './AppIcon';
import { addTemplate } from './launcher';
import { Icon } from '../Icon';
import { styles, palette, stack } from '../../styles';
import { QuietButton } from '../Buttons';

/**
 * Adding an app to a space: first one of your own, asked of an agent
 * (`CreateApp`), then the ready-made ones it doesn't have yet.
 */
export function NewApp({
  space,
  collections,
  apps,
  mayDefine,
  onOwn,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  apps: ReturnType<typeof useSpaceApps>;
  mayDefine: boolean;
  onOwn: () => void;
}) {
  const node = useNode();
  const [adding, setAdding] = useState<Ready | null>(null);
  const { run, busy, error } = useAction();
  const ready: ReadonlyArray<Ready> = [
    ...apps.templates.map((template) => ({
      id: template.app.template,
      title: template.app.title,
      description: template.app.description,
      needs: template.needs,
      uses: template.uses,
      add: () => addTemplate(node, space.id, template, apps.placed),
    })),
  ];

  const add = (app: Ready) => {
    setAdding(app);
    // It joins the sidebar, and leaves this list: you stay here to add another.
    void run(() => app.add());
  };

  return (
    <div style={stack(14)}>
      {space.writable && (
        <button onClick={onOwn} style={ownCard}>
          <span style={ownIcon}>
            <Icon name="sparkle" size={22} />
          </span>
          <span style={{ ...stack(4), flex: 1, minWidth: 0 }}>
            <strong style={{ ...styles.appTitle, fontSize: 19 }}>Add your own</strong>
            <span style={{ fontSize: 14, lineHeight: 1.5, color: palette.ink.body }}>
              Say what {space.name} needs in your own words, and your agent builds it. You add it once it
              looks right.
            </span>
          </span>
          <span data-variant="primary" style={ownGo}>
            Start
          </span>
        </button>
      )}
      <h2 style={{ ...styles.sectionTitle, marginTop: 18 }}>Ready-made</h2>
      <p style={styles.quiet}>
        {ready.length === 0
          ? `${space.name} has every ready-made app.`
          : mayDefine
            ? 'Ready-made. Adding one adds every collection it uses, which hold ordinary records.'
            : 'Someone whose role lets them add collections can add these.'}
      </p>
      <div className="app-list">
        {ready.map((app) => (
          <div key={app.id} style={addRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <AppIcon id={app.id} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={cardTitle}>{app.title}</strong>
                <p style={cardText}>{app.description}</p>
              </div>
              {mayDefine && (
                <QuietButton
                  onClick={() => add(app)}
                  disabled={busy}
                  aria-label={`Add ${app.title}`}
                  style={{ flexShrink: 0 }}
                >
                  {busy && adding?.id === app.id ? 'Adding…' : 'Add'}
                </QuietButton>
              )}
            </div>
            <details style={{ marginTop: 6 }}>
              <summary style={{ ...styles.faint, paddingLeft: 52 }}>What it stores</summary>
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
    </div>
  );
}

/** A ready-made app to add: what the list shows of it, and how to add it */
interface Ready {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly needs: ReadonlyArray<DefineCollection>;
  readonly uses?: ReadonlyArray<DefineCollection> | undefined;
  readonly add: () => Promise<unknown>;
}

/** What an app reads and writes, and whether this space has each yet */
function SchemaList({ app, collections }: { app: Ready; collections: ReadonlyArray<NodeCollection> }) {
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
        const here = collections.some((c) => c.name === s.name && c.version !== null);
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

const cardTitle = { fontSize: 15, fontWeight: 600, color: palette.ink.strong };
const cardText = { fontSize: 13, lineHeight: 1.45, color: palette.ink.muted };
const addRow = { ...styles.tile, padding: 12 } as const;
const ownCard = {
  ...styles.tile,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 16,
  padding: '20px 22px',
  background: palette.accent.soft,
  borderColor: palette.accent.base,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
} as const;
const ownIcon = {
  width: 52,
  height: 52,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: palette.radius.lg,
  background: palette.accent.base,
  color: palette.ink.inverse,
} as const;
const ownGo = {
  ...styles.button,
  width: 'auto',
  padding: '0 20px',
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
} as const;
