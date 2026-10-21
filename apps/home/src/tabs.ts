import { useCallback, useEffect, useState } from 'react';

/** The account page's tabs, in the order the nav shows them */
export const TABS = [
  { id: 'home', label: 'Overview' },
  { id: 'apps', label: 'Apps' },
  { id: 'devices', label: 'Devices' },
  { id: 'data', label: 'Data' },
  { id: 'security', label: 'Security' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/** Sections apps link to by name, and the tab each is on */
const SECTIONS: Readonly<Record<string, TabId>> = { notifications: 'apps', hosting: 'data' };

const isTab = (value: string): value is TabId => TABS.some((tab) => tab.id === value);

/** The tab the address names: a tab, or a section on one, else home */
function fromHash(): TabId {
  const first = (globalThis.location?.hash ?? '').replace(/^#/, '').split('&')[0] ?? '';
  return isTab(first) ? first : (SECTIONS[first] ?? 'home');
}

/**
 * The open tab, kept in the address so a link or a refresh opens the same one,
 * and back goes to the last.
 */
export function useTab(): [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>(fromHash);
  useEffect(() => {
    const follow = () => setTab(fromHash());
    globalThis.addEventListener('hashchange', follow);
    return () => globalThis.removeEventListener('hashchange', follow);
  }, []);
  const open = useCallback((next: TabId) => {
    setTab(next);
    const { location, history } = globalThis;
    if (location.hash !== `#${next}`)
      history.pushState(null, '', `${location.pathname}${location.search}#${next}`);
    globalThis.scrollTo?.({ top: 0 });
  }, []);
  return [tab, open];
}
