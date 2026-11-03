import { Link, useRouterState } from '@tanstack/react-router';
import { useAccount, useAccountPicture } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useAlerts, useTabDot } from '../alerts';
import { Icon } from '@minca/app-shared/Icon';
import css from './TabBar.module.css';

/**
 * Home, Activity and you, in one bar that runs along the top of a wide screen and the bottom of a
 * phone's (`TabBar.module.css`), with a dot on Activity while some of it is new. Only on the home screen: inside a
 * space, a phone has Back at the left of the space's bar instead.
 */
export function TabBar() {
  const account = useAccount();
  const picture = useAccountPicture();
  const { unread } = useAlerts(account.did);
  useTabDot(unread > 0);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const onHome = path === '/' || path.startsWith('/groups') || path.startsWith('/people');
  return (
    <nav className={css.bar} aria-label="Minca">
      <Link data-intent="ghost" to="/" aria-current={onHome ? 'page' : undefined}>
        <Icon name="home" size={20} />
        Home
      </Link>
      <Link data-intent="ghost" to="/activity">
        <Icon name="bell" size={20} />
        {unread > 0 && <span className={css.dot} aria-label={`${unread} new`} />}
        Activity
      </Link>
      <Link data-intent="ghost" to="/profile">
        <Avatar did={account.did} size={20} round src={picture} />
        Profile
      </Link>
    </nav>
  );
}
