import { useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAccount, useCollections, useHoldSpace } from '@minca/react';
import { usePopover } from './usePopover';
import { markRead, useAlerts, useTabDot } from '../alerts';
import { useAppNotifications, useOwnAutomations } from '../notifications';
import { ago } from '@minca/ui/time';
import { SpaceMark } from './SpaceList';
import { Icon } from './Icon';
import { WatchBuilder } from './automations/WatchBuilder';
import { useSpaceName } from '../workspace';
import styles from './Bell.module.css';

type Tab = 'activity' | 'settings';

/**
 * Notifications, for the whole account in one place: what they matched lately, with a dot while
 * some are new, and what you asked to hear about, turned on or added to from here.
 */
export function Bell({
  spaces,
  here,
  onOpenSpace,
}: {
  spaces: ReadonlyArray<SpaceSummary>;
  /** The space on screen, where something more specific can be picked */
  here?: SpaceSummary | undefined;
  onOpenSpace: (id: string) => void;
}) {
  const { did } = useAccount();
  const { items, unread } = useAlerts(did);
  const setup = useAppNotifications();
  const { open, setOpen, root } = usePopover();
  const [tab, setTab] = useState<Tab>('activity');
  const [building, setBuilding] = useState(false);
  useTabDot(unread > 0);

  // Nothing is on yet: what there is to see is how to turn them on.
  const off = setup.on === 0;

  return (
    // At the foot of a space's rail, the panel opens beside the button, from its bottom edge.
    <div ref={root} className={styles.bell}>
      <button
        data-icon
        onClick={() => {
          if (!open) setTab(off && items.length === 0 ? 'settings' : 'activity');
          setOpen((was) => !was);
          markRead(did);
        }}
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        title="Notifications"
      >
        <Icon name={off ? 'bell' : 'bellOn'} />
        {unread > 0 && (
          <span className={styles.badge} aria-hidden>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <dialog open aria-label="Notifications" className={styles.panel}>
          <header>
            <strong>Notifications</strong>
            <div role="tablist" aria-label="Notifications">
              {(['activity', 'settings'] as const).map((one) => (
                <button key={one} role="tab" aria-selected={tab === one} onClick={() => setTab(one)}>
                  {one === 'activity' ? 'Activity' : 'Settings'}
                </button>
              ))}
            </div>
          </header>

          {tab === 'activity' ? (
            <Activity
              items={items}
              spaces={spaces}
              off={off}
              onSettings={() => setTab('settings')}
              onOpenSpace={(id) => {
                setOpen(false);
                onOpenSpace(id);
              }}
            />
          ) : (
            <Settings
              here={here}
              setup={setup}
              onBuild={() => {
                setOpen(false);
                setBuilding(true);
              }}
            />
          )}
        </dialog>
      )}
      {building && here && <Builder space={here} onClose={() => setBuilding(false)} />}
    </div>
  );
}

/** What notifications matched lately, newest first */
export function Activity({
  items,
  spaces,
  off,
  onSettings,
  onOpenSpace,
}: {
  items: ReturnType<typeof useAlerts>['items'];
  spaces: ReadonlyArray<SpaceSummary>;
  off: boolean;
  /** Where to turn them on, when that is somewhere else */
  onSettings?: () => void;
  onOpenSpace: (id: string) => void;
}) {
  const nameOf = useSpaceName();
  if (items.length === 0)
    return (
      <div className="empty">
        <p>Nothing yet. What your notifications match shows up here, while this app is open.</p>
        {off && onSettings && (
          <button data-intent="quiet" onClick={onSettings}>
            Turn notifications on →
          </button>
        )}
      </div>
    );
  return (
    <ul role="list">
      {items.map((item) => {
        const space = spaces.find((s) => s.id === item.space);
        return (
          <li key={item.record}>
            <button data-intent="open" className="row" onClick={() => onOpenSpace(item.space)}>
              {space && <SpaceMark space={space} size={28} />}
              <span className="stack" data-gap="tight">
                <strong>{item.label}</strong>
                <small>
                  {space ? `${nameOf(space.id) ?? space.name} · ` : ''}
                  {ago(item.at)}
                </small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Whether this browser may show them, and what you asked to hear about, in every space */
export function Settings({
  here,
  setup,
  onBuild,
}: {
  here?: SpaceSummary | undefined;
  setup: ReturnType<typeof useAppNotifications>;
  onBuild?: () => void;
}) {
  const watches = useOwnAutomations();
  const nameOf = useSpaceName();
  const where = (spaceIds: 'all' | ReadonlyArray<string>) =>
    spaceIds === 'all'
      ? 'All your spaces'
      : spaceIds.map((id) => nameOf(id) ?? 'A space you left').join(', ');

  return (
    <div className="stack">
      {setup.permission === 'denied' ? (
        <small>
          Notifications are blocked for this site. Allow them from the icon left of the address, then come
          back here.
        </small>
      ) : setup.permission === 'default' ? (
        // Its own step: a browser prompt opened with the home's window easily goes unseen behind it.
        <Action
          onClick={setup.allow}
          title="Allow notifications in this browser"
          hint={
            setup.on > 0
              ? `${setup.on} on in your account`
              : `First, let ${globalThis.location.host} show them`
          }
        />
      ) : (
        setup.on === 0 && (
          <Action
            onClick={setup.turnOn}
            disabled={setup.asking}
            title={setup.asking ? 'Asking your account home…' : 'Turn on notifications'}
            hint={
              setup.asking ? 'Answer in your account home' : 'Messages, polls and contacts, in every space'
            }
          />
        )
      )}
      {setup.error && <p role="alert">{setup.error}</p>}

      {watches.length > 0 && (
        <>
          <small>You hear about</small>
          <ul role="list">
            {watches.map((sub) => (
              <li key={sub.id} className="row">
                <Icon name={sub.paused ? 'bell' : 'bellOn'} size={14} />
                <span className="stack" data-gap="tight">
                  <strong>{sub.name}</strong>
                  <small>
                    {where(sub.spaces ?? 'all')}
                    {sub.when?.query.where !== undefined ? ' · with conditions' : ''}
                    {sub.paused ? ' · paused' : ''}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <hr />
      {onBuild && (
        <Action
          onClick={onBuild}
          title="Something specific…"
          hint={here ? `Pick what, and when, in ${here.name}` : 'Pick a space, then what, and when'}
        />
      )}
      <Action onClick={setup.manage} title="Pause or remove, in your account ↗" quiet />
    </div>
  );
}

/** The builder needs the space's collections, so the space syncs while it is open */
export function Builder({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  useHoldSpace(space.id);
  const collections = useCollections(space.id);
  return <WatchBuilder space={space} collections={collections} onClose={onClose} />;
}

function Action({
  onClick,
  title,
  hint,
  disabled,
  quiet,
}: {
  onClick: () => void;
  title: string;
  hint?: string;
  disabled?: boolean;
  quiet?: boolean;
}) {
  return (
    <button data-intent={quiet ? 'quiet' : 'open'} onClick={onClick} disabled={disabled}>
      <span className="stack" data-gap="tight">
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}
