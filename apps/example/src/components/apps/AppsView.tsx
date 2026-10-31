import { useState, type ReactNode } from 'react';
import { message, useAction } from '@minca/app-shared/action';
import type { NodeCollection, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { useWorkspace } from '../../workspace';
import { SPACE_KEEPERS } from '@minca/core';
import { useMay } from '@minca/app-shared/may';
import { AddBotDialog } from '@minca/app-shared/CommunitySetup';
import { FeatureIcon } from '@minca/app-shared/Feature';
import { ConnectAgent } from '../ConnectAgent';
import { HOOD, sectionsOf, type SpaceScreen } from '../SpaceView';
import { RowMenu } from '../PeopleParts';
import type { AppEntry, useSpaceApps } from './entries';
import { AppIcon, Count } from './AppIcon';
import { Proposals } from './MadeApps';
import { copyApp, moveApp, removeApp } from './launcher';
import { Icon } from '../Icon';
import { unreadOf, type Unread } from '../../seen';
import { styles, palette, variants, hstack, stack, ui } from '../../styles';
import { PrimaryButton } from '../Buttons';
import { confirmThen } from '../../confirm';

/**
 * A space's apps like a phone's home screen: those added, then proposals.
 * Ready-made ones to add are under New app (`NewApp`). Someone who may add collections can arrange them: move
 * them, or take them off. Taking one off keeps everything it holds. Arranging is also where an app is copied
 * to another of your spaces.
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
  // Groups of yours to propose an app in: not this one, nor a space for two.
  const others = spaces.filter((other) => other.id !== space.id && other.writable && !pairs.has(other.id));
  const [copied, setCopied] = useState<string | null>(null);
  const [addingBot, setAddingBot] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // A bot runs where the space is kept online, so adding one is for whoever chooses that.
  const mayAddBot = useMay(space.id, SPACE_KEEPERS) && space.writable;
  const copy = (app: AppEntry, to: SpaceSummary) => {
    setCopied(null);
    copyApp(node, space.id, app.record, to.id).then(
      () => setCopied(`${app.title} is proposed in ${to.name}. People there add it if they want it.`),
      (e: unknown) => setCopied(message(e)),
    );
  };

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
    <div style={stack(36)}>
      <section aria-label="Apps in this space" style={stack(14)}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Apps</h2>
            <p style={{ ...styles.quiet, marginTop: 2 }}>
              What you use together here. Everything they save stays in the space.
            </p>
          </div>
          <div style={{ ...hstack(8), flexShrink: 0 }}>
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
              <PrimaryButton onClick={onCreate} className="hide-on-phone" style={{ ...inlineButton }}>
                <Icon name="plus" size={14} /> Add app
              </PrimaryButton>
            )}
          </div>
        </div>

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

      <section aria-label="Agents" style={stack(14)}>
        <div>
          <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Agents</h2>
          <p style={{ ...styles.quiet, marginTop: 2 }}>AI that works in {space.name} with you.</p>
        </div>
        <ol className="rows" style={ui.list}>
          {mayAddBot && (
            <OverviewRow
              icon={<FeatureIcon kind="bot" size={36} />}
              title="Add a community bot"
              detail="Everyone here can mention it. It answers, sums up threads and posts reminders."
              onClick={() => setAddingBot(true)}
            />
          )}
          <OverviewRow
            icon={<FeatureIcon kind="online" size={36} />}
            title="Connect your own agent"
            detail="Claude, Cursor or another AI of yours, working here as you."
            onClick={() => setConnecting(true)}
          />
        </ol>
      </section>

      <section aria-label="Group" style={stack(14)}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>{pairs.has(space.id) ? 'Chat' : 'Group'}</h2>
        <ol className="rows" style={ui.list}>
          {sectionsOf(pairs.has(space.id)).map((section) => (
            <OverviewRow
              key={section.to}
              icon={
                <span style={sectionIcon}>
                  <Icon name={section.icon} size={18} />
                </span>
              }
              title={section.label}
              onClick={() => go(section.to)}
            />
          ))}
        </ol>
      </section>

      {/* The views for the curious: what the space holds and how it travels. */}
      <section aria-label="Under the hood" style={stack(14)}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Under the hood</h2>
        <ol className="rows" style={ui.list}>
          {HOOD.map((view) => (
            <OverviewRow
              key={view.id}
              icon={
                <span style={sectionIcon}>
                  <Icon name={view.icon} size={18} />
                </span>
              }
              title={view.label}
              onClick={() => go(view.to)}
            />
          ))}
        </ol>
      </section>

      {addingBot && (
        <AddBotDialog
          spaceId={space.id}
          writable={space.writable}
          onAutomations={() => {
            setAddingBot(false);
            go('/spaces/$spaceId/automations');
          }}
          onClose={() => setAddingBot(false)}
        />
      )}
      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}
    </div>
  );
}

/** A row of the Overview that leads somewhere: its icon, what it is, a line on it, and the way there */
function OverviewRow({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <li data-tile style={{ listStyle: 'none' }}>
      <button onClick={onClick} style={rowButton}>
        {icon}
        <span style={{ ...stack(2), flex: 1, minWidth: 0 }}>
          <strong style={cardTitle}>{title}</strong>
          {detail && <span style={cardText}>{detail}</span>}
        </span>
        <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
    </li>
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
        /** What else can be done to it: copying it to another group, and taking it off */
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

const rowButton = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  minHeight: 64,
  padding: '12px 16px',
  border: 'none',
  borderRadius: 'inherit',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
} as const;
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
// As tall as a finger needs (`pointer: coarse` raises buttons to 40), and as wide, so they stay round.
/** A section's line icon, on the same tile an app's shape takes */
const sectionIcon = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  color: palette.ink.body,
} as const;

const roundButton = { ...styles.smallButton, width: 36, height: 36 } as const;
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
