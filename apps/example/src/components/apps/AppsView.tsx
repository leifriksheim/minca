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
import { Icon } from '../Icon';
import { unreadOf, type Unread } from '../../seen';
import { styles, palette, stack, ui } from '../../styles';
import { LinkButton, PrimaryButton } from '../Buttons';
import { confirmThen } from '../../confirm';
import { cardText, cardTitle, rowButton, sectionHeading } from '../rows';

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
    <div style={stack(28)}>
      {/* Who is here, a call, and the rest of the space, a tap away. */}
      <nav aria-label={pair ? 'This chat' : 'This group'} className="quick-row scroll-x">
        {!pair && PEOPLE_PAGES.map((page) => <QuickPage key={page.to} page={page} go={go} />)}
        <CallButton space={space} />
        <CallButton space={space} video />
        <QuickPage page={SETTINGS_PAGE} go={go} />
      </nav>

      <section aria-label="Apps in this space" style={stack(12)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={sectionHeading}>Apps</h2>
          {mayDefine && apps.ready.length > 0 && (
            <LinkButton
              onClick={() => setArranging((was) => !was)}
              aria-pressed={arranging}
              style={{ paddingRight: 0 }}
            >
              {arranging ? 'Done' : 'Arrange'}
            </LinkButton>
          )}
        </div>

        {stale.length > 0 && !arranging && (
          <div style={updateNote}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {stale.length === 1
                ? `A new version of ${stale[0]!.app.title} is ready.`
                : `New versions of ${stale.map(({ app }) => app.title).join(', ')} are ready.`}
            </span>
            <PrimaryButton onClick={update} disabled={arrange.busy} style={inlineButton}>
              {arrange.busy ? 'Updating…' : 'Update'}
            </PrimaryButton>
          </div>
        )}

        {/* One list, arranging or not: arranging only swaps each row's arrow for its moves. */}
        {apps.ready.length > 0 || space.writable ? (
          <ol aria-label={arranging ? 'Arrange apps' : 'Apps'} className="rows" style={ui.list}>
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
              <li data-tile style={{ listStyle: 'none' }}>
                <button onClick={onCreate} style={rowButton}>
                  <span style={slot} aria-hidden>
                    <Icon name="plus" size={16} />
                  </span>
                  <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
                    <strong style={{ ...cardTitle, color: palette.ink.body }}>Add app</strong>
                    <span style={cardText}>A ready-made one, or one an agent builds for you</span>
                  </span>
                </button>
              </li>
            )}
          </ol>
        ) : (
          <p style={styles.quiet}>No apps here yet.</p>
        )}
        {arrange.error && <p style={styles.error}>{arrange.error}</p>}
        {copied && arranging && <p style={styles.quiet}>{copied}</p>}
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
    </div>
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
    <button onClick={() => go(page.to)} className="quick-action">
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
      <AppIcon id={app.id} size={36} />
      <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
        <strong style={{ ...cardTitle, ...ui.ellipsis }}>{app.title}</strong>
        {app.description && <span style={{ ...cardText, ...ui.ellipsis }}>{app.description}</span>}
      </span>
    </>
  );
  if (!arrange)
    return (
      <li data-tile style={{ listStyle: 'none' }}>
        <button onClick={onOpen} style={rowButton}>
          {about}
          <Count unread={unread} />
          <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
            <Icon name="chevron" size={14} />
          </span>
        </button>
      </li>
    );
  // One line on every screen: the app, its moves, and the rest behind a menu.
  return (
    <li style={{ ...rowButton, listStyle: 'none', padding: '8px 10px 8px 16px' }}>
      <AppIcon id={app.id} size={32} />
      <strong style={{ ...cardTitle, ...ui.ellipsis, flex: 1, minWidth: 0 }}>{app.title}</strong>
      <button
        onClick={() => arrange.onMove(-1)}
        disabled={arrange.busy || arrange.first}
        aria-label={`Move ${app.title} up`}
        data-variant="quiet"
        data-round
        style={roundButton}
      >
        <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      <button
        onClick={() => arrange.onMove(1)}
        disabled={arrange.busy || arrange.last}
        aria-label={`Move ${app.title} down`}
        data-variant="quiet"
        data-round
        style={roundButton}
      >
        <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      <RowMenu label={`More for ${app.title}`} items={arrange.menu} />
    </li>
  );
}

/** Where the next app goes: an empty tile, dashed */
const slot = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1.5px dashed ${palette.surface.lineStrong}`,
  borderRadius: palette.radius.md,
  color: palette.ink.muted,
} as const;
/** A word above the apps that some of them have a newer version, and the button that brings them up to date */
const updateNote = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 10px 10px 16px',
  borderRadius: palette.radius.lg,
  background: palette.accent.soft,
  color: palette.ink.strong,
  fontSize: 14,
} as const;

const roundButton = { ...styles.smallButton, width: 36, height: 36 } as const;
const inlineButton = {
  width: 'auto',
  height: 36,
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
} as const;
