import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@minca/core';
import { useAccount } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { markRead, useAlerts } from '../alerts';
import { useAppNotifications } from '../notifications';
import { useSpaceName, useWorkspace } from '../workspace';
import { Activity, Builder, Settings } from './Bell';
import { SpaceMark } from './SpaceList';
import { Icon } from './Icon';

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
    <section>
      <header>
        <h1>Activity</h1>
        {!off && (
          <button data-intent="quiet" onClick={() => setManaging(true)}>
            <Icon name="bellOn" size={14} /> Manage
          </button>
        )}
      </header>

      {off ? (
        <TurnOn setup={setup} />
      ) : (
        <Activity items={items} spaces={spaces} off={setup.on === 0} onOpenSpace={openSpace} />
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
          <ul role="list">
            {spaces.map((space) => (
              <li key={space.id}>
                <button
                  data-intent="open"
                  className="row"
                  onClick={() => {
                    setPicking(false);
                    setBuilding(space);
                  }}
                >
                  <SpaceMark space={space} size={28} />
                  <strong className="truncate">{nameOf(space.id) ?? space.name}</strong>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {building && <Builder space={building} onClose={() => setBuilding(null)} />}
    </section>
  );
}

/** Nothing on yet: what you'd hear about, and the one step that turns it on in this browser */
function TurnOn({ setup }: { setup: ReturnType<typeof useAppNotifications> }) {
  return (
    <div className="empty">
      <Icon name="bell" size={28} />
      <strong>Hear about what's new</strong>
      <p>Messages, polls and contact requests, in every space, while this app is open.</p>
      {setup.permission === 'denied' ? (
        <p role="alert">
          Notifications are blocked for this site. Allow them from the icon left of the address, then come
          back here.
        </p>
      ) : setup.permission === 'default' ? (
        // Its own step: a browser prompt opened with the home's window easily goes unseen behind it.
        <button data-intent="primary" onClick={setup.allow}>
          Allow notifications
        </button>
      ) : (
        <button data-intent="primary" onClick={setup.turnOn} disabled={setup.asking}>
          {setup.asking ? 'Answer in your account home…' : 'Turn on notifications'}
        </button>
      )}
      {setup.error && <p role="alert">{setup.error}</p>}
    </div>
  );
}
