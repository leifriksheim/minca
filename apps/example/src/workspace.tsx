import { createContext, useContext } from 'react';
import type { NewSpace, SpaceSummary } from '@minca/core';
import type { PairWith } from './contacts';
import { InviteBanner } from './components/InviteBanner';
import { RelayNotice } from './components/RelayNotice';

/** Your spaces, and what to do with them, for every page under `App` */
export interface Workspace {
  readonly spaces: ReadonlyArray<SpaceSummary>;
  /** Your spaces for two, and who each is with: People, where every other space is a group */
  readonly pairs: ReadonlyMap<string, PairWith>;
  readonly loading: boolean;
  readonly error: string | null;
  /** Make a group with Chat in it, invite these contacts (by account), and go to it to add people */
  readonly create: (params: NewSpace, invite?: ReadonlyArray<string>) => void;
  /** Join with an invite link, and go to the space */
  readonly join: (link: string) => void;
  /** Join with an invite link; the space, or null when it failed */
  readonly joinLink: (link: string) => Promise<SpaceSummary | null>;
  /** Leave a space, after saying what it costs */
  readonly forget: (id: string) => void;
  /** Go to a space, on its Overview */
  readonly openSpace: (id: string) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace needs the workspace (App) above it');
  return workspace;
}

/**
 * A space by the name people know it by: a group by its own, a space for two as the chat with whom it
 * is with, so a list of both says which is which. Null for a space this device doesn't have.
 */
export function useSpaceName(): (id: string) => string | null {
  const { spaces, pairs } = useWorkspace();
  return (id) => {
    const pair = pairs.get(id);
    if (pair) return `Chat with ${pair.name}`;
    return spaces.find((space) => space.id === id)?.name ?? null;
  };
}

/** Banners about the connection and invites, above whatever is open */
export function Notices({ inSpace = false }: { inSpace?: boolean }) {
  const { error, joinLink, openSpace } = useWorkspace();
  return (
    <>
      {/* At home the list of spaces shows the error itself. */}
      {inSpace && error && (
        <aside data-tone="danger" role="alert">
          {error}
        </aside>
      )}
      <InviteBanner
        onJoin={(link) =>
          joinLink(link).then((space) => {
            if (space) openSpace(space.id);
            return space;
          })
        }
      />
      <RelayNotice />
    </>
  );
}

/** The lists on the home screen, each a tab: everything, your groups, your people */
export type HomeTab = '/' | '/groups' | '/people';

// The tab you were last on, for this browser tab, so leaving a space returns to it.
let lastHome: HomeTab = '/';

/** Keeps which home tab is showing, for a space's way back (`homeTab`) */
export const rememberHome = (tab: HomeTab): void => {
  lastHome = tab;
};

/** The home tab a space was opened from, as far as this page knows: All when it doesn't */
export const homeTab = (): HomeTab => lastHome;
