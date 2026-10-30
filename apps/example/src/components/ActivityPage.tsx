import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAccount } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { markRead, useAlerts } from '../alerts';
import { useAppNotifications } from '../notifications';
import { useSpaceName, useWorkspace } from '../workspace';
import { Activity, Builder, Settings } from './Bell';
import { SpaceMark } from './SpaceList';
import { AddButton, QuietButton } from './Buttons';
import { Icon } from './Icon';
import { palette, stack, styles, ui } from '../styles';

/**
 * What your notifications matched lately, at `/activity`; looking is reading them. With none on,
 * the page is the way to turn them on. Once some are, what you hear about is behind Manage, so it
 * never pushes the activity down.
 */
export function ActivityPage() {
  const { spaces, openSpace } = useWorkspace();
  const nameOf = useSpaceName();
  const { did } = useAccount();
  const { items, unread } = useAlerts(did);
  const setup = useAppNotifications();
  const [managing, setManaging] = useState(false);
  // Something specific is picked in one space: which, then what.
  const [picking, setPicking] = useState(false);
  const [building, setBuilding] = useState<SpaceSummary | null>(null);
  useEffect(() => {
    if (unread > 0) markRead(did);
  }, [did, unread]);
  const off = setup.on === 0 && items.length === 0;

  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ ...styles.appTitle, flex: 1 }}>Activity</h1>
        {!off && (
          <QuietButton
            onClick={() => setManaging(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Icon name="bellOn" size={14} /> Manage
          </QuietButton>
        )}
      </header>

      {off ? (
        <TurnOn setup={setup} />
      ) : (
        <div style={{ ...ui.list, paddingTop: 6 }}>
          <Activity items={items} spaces={spaces} off={setup.on === 0} onOpenSpace={openSpace} />
        </div>
      )}

      {managing && (
        <Modal title="Notifications" onClose={() => setManaging(false)}>
          <Settings
            setup={setup}
            onBuild={() => {
              setManaging(false);
              setPicking(true);
            }}
          />
        </Modal>
      )}
      {picking && (
        <Modal title="Which space?" onClose={() => setPicking(false)}>
          <div style={stack(1)}>
            {spaces.map((space) => (
              <button
                key={space.id}
                data-menu-item
                className="side-item"
                style={{ height: 44, fontSize: 15, color: palette.ink.strong }}
                onClick={() => {
                  setPicking(false);
                  setBuilding(space);
                }}
              >
                <SpaceMark space={space} size={28} />
                <span style={ui.ellipsis}>{nameOf(space.id) ?? space.name}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {building && <Builder space={building} onClose={() => setBuilding(null)} />}
    </>
  );
}

/** Nothing on yet: what you'd hear about, and the one step that turns it on in this browser */
function TurnOn({ setup }: { setup: ReturnType<typeof useAppNotifications> }) {
  return (
    <div style={{ ...styles.emptyState, ...stack(10), alignItems: 'center' }}>
      <span style={{ color: palette.ink.strong, display: 'inline-flex' }}>
        <Icon name="bell" size={28} />
      </span>
      <strong style={{ color: palette.ink.strong, fontSize: 15 }}>Hear about what's new</strong>
      <span>Messages, polls and contact requests, in every space, while this app is open.</span>
      {setup.permission === 'denied' ? (
        <span style={{ color: palette.accent.danger }}>
          Notifications are blocked for this site. Allow them from the icon left of the address, then come
          back here.
        </span>
      ) : setup.permission === 'default' ? (
        // Its own step: a browser prompt opened with the home's window easily goes unseen behind it.
        <AddButton onClick={setup.allow} style={{ marginTop: 6, height: 40 }}>
          Allow notifications
        </AddButton>
      ) : (
        <AddButton onClick={setup.turnOn} disabled={setup.asking} style={{ marginTop: 6, height: 40 }}>
          {setup.asking ? 'Answer in your account home…' : 'Turn on notifications'}
        </AddButton>
      )}
      {setup.error && <span style={{ color: palette.accent.danger }}>{setup.error}</span>}
    </div>
  );
}
