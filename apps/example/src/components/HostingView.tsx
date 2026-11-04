import type { SpaceSummary } from '@minca/core';
import { SpaceHosting } from '@minca/app-shared/SpaceHosting';
import { SpaceBots } from '@minca/app-shared/CommunitySetup';

/** Keeping a space online: its host, its fund, and the AI helpers that host runs */
export function HostingView({ space, onAutomations }: { space: SpaceSummary; onAutomations: () => void }) {
  return (
    <section>
      <div className="stack">
        <h2>Hosting</h2>
        <p>
          Keep {space.name} reachable when everyone is offline, paid from one fund anyone here can add to. The
          host keeps it encrypted and can't read it.
        </p>
      </div>
      <SpaceHosting spaceId={space.id} writable={space.writable} />
      <SpaceBots spaceId={space.id} writable={space.writable} onAutomations={onAutomations} />
    </section>
  );
}
