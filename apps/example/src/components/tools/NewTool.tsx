import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import type { DefineCollection, NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import type { useSpaceTools } from './entries';
import { ToolIcon } from './ToolIcon';
import { addTemplate } from './launcher';
import { Icon } from '../Icon';
import { styles, palette, stack } from '../../styles';
import { QuietButton } from '../Buttons';

/**
 * Adding a tool to a space: first one of your own, asked of an agent
 * (`CreateTool`), then the ready-made ones it doesn't have yet.
 */
export function NewTool({
  space,
  collections,
  tools,
  mayDefine,
  onOpenTool,
  onOwn,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  tools: ReturnType<typeof useSpaceTools>;
  mayDefine: boolean;
  onOpenTool: (id: string) => void;
  onOwn: () => void;
}) {
  const node = useNode();
  const [adding, setAdding] = useState<Ready | null>(null);
  const { run, busy, error } = useAction();
  const ready: ReadonlyArray<Ready> = [
    ...tools.templates.map((template) => ({
      id: template.tool.template,
      title: template.tool.title,
      description: template.tool.description,
      needs: template.needs,
      uses: template.uses,
      add: () => addTemplate(node, space.id, template, tools.placed),
    })),
  ];

  const add = (tool: Ready) => {
    setAdding(tool);
    // Added, it opens: what you added it for is the next thing to do.
    void run(async () => {
      await tool.add();
      onOpenTool(tool.id);
    });
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
          ? `${space.name} has every ready-made tool.`
          : mayDefine
            ? 'Ready-made. Adding one adds every collection it uses, which hold ordinary records.'
            : 'Someone whose role lets them add collections can add these.'}
      </p>
      <div className="tool-list">
        {ready.map((tool) => (
          <div key={tool.id} style={addRow}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ToolIcon id={tool.id} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={cardTitle}>{tool.title}</strong>
                <p style={cardText}>{tool.description}</p>
              </div>
              {mayDefine && (
                <QuietButton
                  onClick={() => add(tool)}
                  disabled={busy}
                  aria-label={`Add ${tool.title}`}
                  style={{ flexShrink: 0 }}
                >
                  {busy && adding?.id === tool.id ? 'Adding…' : 'Add'}
                </QuietButton>
              )}
            </div>
            <details style={{ marginTop: 6 }}>
              <summary style={{ ...styles.faint, paddingLeft: 52 }}>What it stores</summary>
              <SchemaList tool={tool} collections={collections} />
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

/** A ready-made tool to add: what the list shows of it, and how to add it */
interface Ready {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly needs: ReadonlyArray<DefineCollection>;
  readonly uses?: ReadonlyArray<DefineCollection> | undefined;
  readonly add: () => Promise<unknown>;
}

/** What a tool reads and writes, and whether this space has each yet */
function SchemaList({ tool, collections }: { tool: Ready; collections: ReadonlyArray<NodeCollection> }) {
  const rows = [
    ...tool.needs.map((s) => ({ s, optional: false })),
    ...(tool.uses ?? []).map((s) => ({ s, optional: true })),
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
