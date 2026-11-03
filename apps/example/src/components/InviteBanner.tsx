import type { SpaceSummary } from '@minca/core';
import { useInviteLink, useMyName } from '@minca/react';
import { NameField } from './NameField';

/** Offered when the page was opened from a share link: join the space, or not now. */
export function InviteBanner({ onJoin }: { onJoin: (invite: string) => Promise<SpaceSummary | null> }) {
  const { invite, preview, dismiss } = useInviteLink();
  const me = useMyName();
  if (!invite) return null;

  const description = preview ? `“${preview.space.name}”` : 'a space';
  const detail = preview
    ? `${preview.space.visibility} · ${
        preview.carriesWrite ? `you join as ${preview.role ?? 'a member'}` : 'view only'
      } · invited by ${preview.invitedBy.slice(-6)}`
    : 'This invite could not be read.';

  return (
    <aside className="stack">
      <div>
        <strong>You were invited to {description}</strong>
        <br />
        <small>{detail}</small>
      </div>
      <NameField value={me.name} onChange={me.setName} />
      <div className="row" data-gap="tight">
        <button
          data-intent="primary"
          onClick={() =>
            void me
              .save()
              .then(() => onJoin(invite))
              .then(dismiss)
          }
        >
          Join this space
        </button>
        <button data-intent="quiet" onClick={dismiss}>
          Not now
        </button>
      </div>
    </aside>
  );
}
