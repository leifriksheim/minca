import { useState, type ReactNode } from 'react';
import { SPACE_KEEPERS } from '@minca/core';
import { useMay } from '@minca/app-shared/may';
import { AddBotDialog } from '@minca/app-shared/CommunitySetup';
import { FeatureIcon } from '@minca/app-shared/Feature';
import { useWorkspace } from '../workspace';
import { ConnectAgent } from './ConnectAgent';
import { HOOD, settingsPagesOf, type SpaceScreen } from './SpaceView';
import { cardText, cardTitle, rowButton, sectionHeading } from './rows';
import { Icon, type IconName } from './Icon';
import { palette, stack, ui } from '../styles';

/** A space's Settings: its agents, where it is kept, what runs on its own, what is under the hood, and leaving */
export function SpaceSettings({ space, go }: Pick<SpaceScreen, 'space' | 'go'>) {
  const { pairs, forget } = useWorkspace();
  const pair = pairs.has(space.id);
  const [addingBot, setAddingBot] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // A bot runs where the space is kept online, so adding one is for whoever chooses that.
  const mayAddBot = useMay(space.id, SPACE_KEEPERS) && space.writable;

  return (
    <div style={stack(32)}>
      <section aria-label="Agents" style={stack(12)}>
        <h2 style={sectionHeading}>Agents</h2>
        <ol className="rows" style={ui.list}>
          {mayAddBot && (
            <SettingsRow
              icon={<FeatureIcon kind="bot" size={36} />}
              title="Add a community bot"
              detail="Everyone here can mention it. It answers, sums up threads and posts reminders."
              onClick={() => setAddingBot(true)}
            />
          )}
          <SettingsRow
            icon={<FeatureIcon kind="online" size={36} />}
            title="Connect your own agent"
            detail="Claude, Cursor or another AI of yours, working here as you."
            onClick={() => setConnecting(true)}
          />
        </ol>
      </section>

      <section aria-label={pair ? 'Chat' : 'Group'} style={stack(12)}>
        <h2 style={sectionHeading}>{pair ? 'Chat' : 'Group'}</h2>
        <ol className="rows" style={ui.list}>
          {settingsPagesOf(pair).map((section) => (
            <SettingsRow
              key={section.to}
              icon={<LineIcon name={section.icon} />}
              title={section.label}
              onClick={() => go(section.to)}
            />
          ))}
          <li data-tile style={{ listStyle: 'none' }}>
            <button onClick={() => forget(space.id)} style={rowButton}>
              <span style={{ ...lineIcon, color: palette.accent.danger }}>
                <Icon name="arrowLeft" size={18} />
              </span>
              <strong style={{ ...cardTitle, color: palette.accent.danger }}>
                {pair ? 'Leave this chat' : 'Leave group'}
              </strong>
            </button>
          </li>
        </ol>
      </section>

      {/* The views for the curious: what the space holds and how it travels. */}
      <section aria-label="Under the hood" style={stack(12)}>
        <h2 style={sectionHeading}>Under the hood</h2>
        <ol className="rows" style={ui.list}>
          {HOOD.map((view) => (
            <SettingsRow
              key={view.id}
              icon={<LineIcon name={view.icon} />}
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

/** A row that leads somewhere: its icon, what it is, a line on it, and the way there */
function SettingsRow({
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

/** A line icon on the same tile an app's shape takes */
function LineIcon({ name }: { name: IconName }) {
  return (
    <span style={lineIcon}>
      <Icon name={name} size={18} />
    </span>
  );
}

const lineIcon = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  color: palette.ink.body,
} as const;
