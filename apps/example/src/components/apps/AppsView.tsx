import { useState } from 'react';
import { message, useAction } from '@minca/app-shared/action';
import type { NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { useWorkspace } from '../../workspace';
import { PEOPLE_PAGES, SETTINGS_PAGE, type SpaceScreen } from '../SpaceView';
import { CallButton } from '../calls/Calls';
import { RowMenu } from '../PeopleParts';
import type { AppEntry, useSpaceApps } from './entries';
import { AppIcon, Count } from './AppIcon';
import { Proposals } from './MadeApps';
import { copyApp, moveApp, outdated, removeApp, updateTemplate } from './launcher';
import { TEMPLATES } from './templates';
import { AppSettings } from './AppSettings';
import { Icon } from '@minca/app-shared/Icon';
import { unreadOf, type Unread } from '../../seen';
import { confirmThen } from '../../confirm';
import styles from './AppsView.module.css';

/**
 * A space's Overview: a row of its own pages, then its apps like a phone's home screen, those added and then
 * proposals.
 * Ready-made ones to add are under New app (`NewApp`). Someone who may add collections can arrange them: move
 * them, or take them off. Taking one off keeps everything it holds. Arranging is also where an app is copied
 * to another of your spaces, and where an app that asks for settings, like an API key, has them filled in.
 */
export function AppsView({
  space,
  collections,
  apps,
  unread,
  mayDefine,
  go,
  onOpenApp,
  onCreate,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  apps: ReturnType<typeof useSpaceApps>;
  unread: ReadonlyMap<string, Unread>;
  mayDefine: boolean;
  go: SpaceScreen['go'];
  onOpenApp: (id: string) => void;
  onCreate: () => void;
}) {
  const node = useNode();
  const [arranging, setArranging] = useState(false);
  const arrange = useAction();
  const { spaces, pairs } = useWorkspace();
  const pair = pairs.has(space.id);
  // Groups of yours to propose an app in: not this one, nor a space for two.
  const others = spaces.filter((other) => other.id !== space.id && other.writable && !pairs.has(other.id));
  const [copied, setCopied] = useState<string | null>(null);
  const [setting, setSetting] = useState<AppEntry | null>(null);
  const copy = (app: AppEntry, to: SpaceSummary) => {
    setCopied(null);
    copyApp(node, space.id, app.record, to.id).then(
      () => setCopied(`${app.title} is proposed in ${to.name}. People there add it if they want it.`),
      (e: unknown) => setCopied(message(e)),
    );
  };

  // Ready-made apps this space has an older copy of: someone who may add apps brings them up to date.
  const stale = mayDefine
    ? apps.ready.flatMap((app) => {
        const template = TEMPLATES.find((one) => one.app.template === app.record.body?.template);
        return template && outdated(app.record, template) ? [{ app, template }] : [];
      })
    : [];
  const update = () =>
    void arrange.run(async () => {
      for (const { app, template } of stale) await updateTemplate(node, space.id, app.record, template);
    });

  const move = (app: AppEntry, by: number) => {
    const at = apps.placed.findIndex((record) => record.key === app.record.key);
    void arrange.run(() => moveApp(node, space.id, apps.placed, app.record.key, at + by));
  };
  const remove = (app: AppEntry) =>
    confirmThen(
      app.record.body?.template
        ? 'Everything it holds stays in the space, and adding it again brings it back.'
        : 'Everything it holds stays in the space; to have the app again, someone proposes it again.',
      { title: `Take ${app.title} off ${space.name}?`, yes: 'Take it off' },
      () => arrange.run(() => removeApp(node, space.id, app.record, apps.records)),
    );

  return (
    <>
      {/* Who is here, a call, and the rest of the space, a tap away. */}
      <nav aria-label={pair ? 'This chat' : 'This group'} className={styles.quick}>
        {!pair && PEOPLE_PAGES.map((page) => <QuickPage key={page.to} page={page} go={go} />)}
        <CallButton space={space} />
        <CallButton space={space} video />
        <QuickPage page={SETTINGS_PAGE} go={go} />
      </nav>

      <section aria-label="Apps in this space">
        <header>
          <h2>Apps</h2>
          {mayDefine && apps.ready.length > 0 && (
            <button type="button" data-intent="ghost" onClick={() => setArranging((was) => !was)}>
              {arranging ? 'Done' : 'Arrange'}
            </button>
          )}
        </header>

        {stale.length > 0 && !arranging && (
          <aside className="row" data-spread>
            <span>
              {stale.length === 1
                ? `A new version of ${stale[0]!.app.title} is ready.`
                : `New versions of ${stale.map(({ app }) => app.title).join(', ')} are ready.`}
            </span>
            <button type="button" data-intent="primary" onClick={update} disabled={arrange.busy}>
              {arrange.busy ? 'Updating…' : 'Update'}
            </button>
          </aside>
        )}

        {/* One list, arranging or not: arranging only swaps each row's arrow for its moves. */}
        {apps.ready.length > 0 || space.writable ? (
          <ol role="list" aria-label={arranging ? 'Arrange apps' : 'Apps'}>
            {apps.ready.map((app, at) => (
              <AppRow
                key={app.id}
                app={app}
                unread={unreadOf(unread, app.id)}
                onOpen={() => onOpenApp(app.id)}
                arrange={
                  arranging
                    ? {
                        busy: arrange.busy,
                        first: at === 0,
                        last: at === apps.ready.length - 1,
                        onMove: (by) => move(app, by),
                        menu: [
                          ...(app.record.body?.settings?.length
                            ? [{ label: 'Settings', onClick: () => setSetting(app) }]
                            : []),
                          ...others.map((other) => ({
                            label: `Copy to ${other.name}`,
                            onClick: () => copy(app, other),
                          })),
                          { label: 'Remove', danger: true, onClick: () => remove(app) },
                        ],
                      }
                    : undefined
                }
              />
            ))}
            {space.writable && !arranging && (
              <li>
                <button type="button" data-intent="open" className="row" onClick={onCreate}>
                  <span className={styles.slot} aria-hidden>
                    <Icon name="plus" size={16} />
                  </span>
                  <span className="stack truncate" data-gap="tight">
                    <strong>Add app</strong>
                    <small>A ready-made one, or one an agent builds for you</small>
                  </span>
                </button>
              </li>
            )}
          </ol>
        ) : (
          <small>No apps here yet.</small>
        )}
        {arrange.error && <p role="alert">{arrange.error}</p>}
        {copied && arranging && <small>{copied}</small>}
      </section>

      <Proposals
        space={space}
        proposals={apps.proposed}
        placed={apps.placed}
        collections={collections}
        mayDefine={mayDefine}
        onAdded={(key) => onOpenApp(`made:${key}`)}
      />

      {setting && <AppSettings space={space} record={setting.record} onClose={() => setSetting(null)} />}
    </>
  );
}

/** One of the space's own pages in the row atop the Overview: its icon over its name */
function QuickPage({
  page,
  go,
}: {
  page: typeof SETTINGS_PAGE | (typeof PEOPLE_PAGES)[number];
  go: SpaceScreen['go'];
}) {
  return (
    <button type="button" data-intent="ghost" onClick={() => go(page.to)}>
      <Icon name={page.icon} size={20} />
      {page.label}
    </button>
  );
}

/**
 * An app in the list: its shape, its name, a line on what it's for and what's new in it. A tap opens
 * it; while arranging, its moves take the arrow's place, so the list itself never changes shape.
 */
function AppRow({
  app,
  unread,
  onOpen,
  arrange,
}: {
  app: AppEntry;
  unread: Unread;
  onOpen: () => void;
  arrange:
    | {
        readonly busy: boolean;
        readonly first: boolean;
        readonly last: boolean;
        readonly onMove: (by: number) => void;
        /** What else can be done to it: its settings, copying it to another group, and taking it off */
        readonly menu: ReadonlyArray<{ label: string; onClick: () => void; danger?: boolean }>;
      }
    | undefined;
}) {
  const about = (
    <>
      <AppIcon app={app} size={36} />
      <span className="stack truncate" data-gap="tight">
        <strong className="truncate">{app.title}</strong>
        {app.description && <small className="truncate">{app.description}</small>}
      </span>
    </>
  );
  if (!arrange)
    return (
      <li>
        <button type="button" data-intent="open" className="row" onClick={onOpen}>
          {about}
          <Count unread={unread} />
          <Icon name="chevron" size={14} />
        </button>
      </li>
    );
  // One line on every screen: the app, its moves, and the rest behind a menu.
  return (
    <li className="row">
      <AppIcon app={app} size={32} />
      <strong className="truncate">{app.title}</strong>
      <button
        type="button"
        data-intent="ghost"
        data-icon
        className={styles.up}
        onClick={() => arrange.onMove(-1)}
        disabled={arrange.busy || arrange.first}
        aria-label={`Move ${app.title} up`}
      >
        <Icon name="chevron" size={14} />
      </button>
      <button
        type="button"
        data-intent="ghost"
        data-icon
        className={styles.down}
        onClick={() => arrange.onMove(1)}
        disabled={arrange.busy || arrange.last}
        aria-label={`Move ${app.title} down`}
      >
        <Icon name="chevron" size={14} />
      </button>
      <RowMenu label={`More for ${app.title}`} items={arrange.menu} />
    </li>
  );
}
