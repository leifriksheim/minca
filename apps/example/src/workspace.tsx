import { createContext, useContext } from 'react';
import type { NewSpace, SpaceSummary } from '@minca/core';
import { InviteBanner } from './components/InviteBanner';
import { RelayNotice } from './components/RelayNotice';
import { styles } from './styles';

/** Your spaces, and what to do with them, for every page under `App` */
export interface Workspace {
  readonly spaces: ReadonlyArray<SpaceSummary>;
  readonly loading: boolean;
  readonly error: string | null;
  /** Make a space, and go to it */
  readonly create: (params: NewSpace) => void;
  /** Join with an invite link, and go to the space */
  readonly join: (link: string) => void;
  /** Join with an invite link; the space, or null when it failed */
  readonly joinLink: (link: string) => Promise<SpaceSummary | null>;
  /** Leave a space, after saying what it costs */
  readonly forget: (id: string) => void;
  /** Go to a space */
  readonly openSpace: (id: string) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('useWorkspace needs the workspace (App) above it');
  return workspace;
}

/** Banners about the connection and invites, above whatever is open */
export function Notices({ inSpace = false }: { inSpace?: boolean }) {
  const { error, joinLink, openSpace } = useWorkspace();
  return (
    <>
      {/* At home the list of spaces shows the error itself. */}
      {inSpace && error && (
        <div style={{ ...styles.errorBox, marginTop: 0, marginBottom: 16 }}>
          <p style={styles.error}>{error}</p>
        </div>
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
