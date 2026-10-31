import { Link, useRouterState } from '@tanstack/react-router';
import { useAccount, useAccountPicture } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useAlerts, useTabDot } from '../alerts';
import { Icon } from './Icon';

/**
 * Home, Activity and you, in one bar that runs along the top of a wide screen and the bottom of a
 * phone's (`.tabbar`), with a dot on Activity while some of it is new. A phone keeps it inside a space
 * too, so the way home is always one tap.
 */
export function TabBar() {
  const account = useAccount();
  const picture = useAccountPicture();
  const { unread } = useAlerts(account.did);
  useTabDot(unread > 0);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const onHome = path === '/' || path.startsWith('/people');
  return (
    <nav className="tabbar" aria-label="Minca">
      <Link to="/" aria-current={onHome ? 'page' : undefined}>
        <Icon name="home" size={20} />
        Home
      </Link>
      <Link to="/activity">
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="tab-dot" aria-label={`${unread} new`} />}
        Activity
      </Link>
      <Link to="/profile">
        <Avatar did={account.did} size={20} round src={picture} />
        Profile
      </Link>
    </nav>
  );
}
