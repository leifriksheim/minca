import { useState } from 'react';
import { useAction } from '@minca/app-shared/action';
import type { DefineCollection, NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import type { useSpaceApps } from './entries';
import { AppIcon } from './AppIcon';
import { addTemplate, DIRECT } from './launcher';
import { useWorkspace } from '../../workspace';
import { Icon } from '@minca/app-shared/Icon';
import marks from '../InvitePeople.module.css';

/**
 * Adding an app to a space: first one of your own, asked of an agent
 * (`CreateApp`), then the ready-made ones it doesn't have yet.
 */
export function NewApp({
  space,
  collections,
  apps,
  mayDefine,
  onOpenApp,
  onOwn,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  apps: ReturnType<typeof useSpaceApps>;
  mayDefine: boolean;
  onOpenApp: (id: string) => void;
  onOwn: () => void;
}) {
  const node = useNode();
  const [adding, setAdding] = useState<Ready | null>(null);
  const { run, busy, error } = useAction();
  // Direct messages are for a group: a space for two is one already. They are sealed to members' keys,
  // which only a private space's members publish.
  const forTwo = useWorkspace().pairs.has(space.id);
  const offered = apps.templates.filter(
    ({ app }) => app.template !== DIRECT || (!forTwo && space.visibility === 'private'),
  );
  const ready: ReadonlyArray<Ready> = [
    ...offered.map((template) => ({
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
    // Added, it opens: what you added it for is the next thing to do.
    void run(async () => {
      await app.add();
      onOpenApp(app.id);
    });
  };

  return (
    <div className="stack" data-gap="loose">
      {space.writable && (
        <button type="button" data-intent="open" data-hue="1" className="row" onClick={onOwn}>
          <span className={marks.mark}>
            <Icon name="sparkle" size={18} />
          </span>
          <span className="stack truncate" data-gap="tight">
            <strong>Add your own</strong>
            <small>Say what {space.name} needs, and your agent builds it.</small>
          </span>
          <Icon name="chevron" size={14} />
        </button>
      )}
      <section>
        <h2>Ready-made</h2>
        <small>
          {ready.length === 0
            ? `${space.name} has every ready-made app.`
            : mayDefine
              ? 'Ready-made. Adding one adds every collection it uses, which hold ordinary records.'
              : 'Someone whose role lets them add collections can add these.'}
        </small>
        {ready.map((app) => (
          <article key={app.id}>
            <div className="row">
              <AppIcon app={app} size={40} />
              <div className={`stack ${marks.grow}`}>
                <strong>{app.title}</strong>
                <small>{app.description}</small>
              </div>
              {mayDefine && (
                <button
                  type="button"
                  onClick={() => add(app)}
                  disabled={busy}
                  aria-label={`Add ${app.title}`}
                >
                  {busy && adding?.id === app.id ? 'Adding…' : 'Add'}
                </button>
              )}
            </div>
            <details>
              <summary>
                <small>What it stores</small>
              </summary>
              <SchemaList app={app} collections={collections} />
            </details>
          </article>
        ))}
      </section>
      {error && (
        <p role="alert">
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
    <ul role="list">
      {rows.map(({ s, optional }) => {
        const here = collections.some((c) => c.name === s.name && c.version !== null);
        return (
          <li key={s.name} className="row" data-spread>
            <span>
              {s.title} <code>{s.name}</code>
            </span>
            <small data-tone={here ? 'good' : undefined}>
              {here ? 'in this space' : optional ? 'will be added, for when it is used' : 'will be added'}
            </small>
          </li>
        );
      })}
    </ul>
  );
}
