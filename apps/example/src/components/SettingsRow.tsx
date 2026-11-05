import type { ReactNode } from 'react';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import marks from './InvitePeople.module.css';

/** A row that leads somewhere: its icon, what it is, a line on it, and the way there */
export function SettingsRow({
  icon,
  title,
  detail,
  onClick,
  away,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  onClick: () => void;
  /** It opens somewhere else, the account home in a window of its own */
  away?: boolean;
}) {
  return (
    <li>
      <button data-intent="open" onClick={onClick} className="row">
        {icon}
        <span className="stack truncate" data-gap="tight">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        <Icon name={away ? 'external' : 'chevron'} size={14} />
      </button>
    </li>
  );
}

/** A line icon on the same tile an app's shape takes */
export function LineIcon({ name }: { name: IconName }) {
  return (
    <span className={marks.mark}>
      <Icon name={name} size={18} />
    </span>
  );
}
