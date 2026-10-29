import type { SpaceSummary } from '@minca/core';
import { useInviteLink, useMyName } from '@minca/react';
import { NameField } from './NameField';
import { styles } from '../styles';
import { AddButton, LinkButton } from './Buttons';

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
    <div style={styles.inviteBanner}>
      <p style={styles.todoText}>You were invited to {description}</p>
      <p style={styles.todoMeta}>{detail}</p>
      <div style={{ marginTop: 12, maxWidth: 320 }}>
        <NameField value={me.name} onChange={me.setName} />
      </div>
      <div style={styles.linkRow}>
        <AddButton
          onClick={() =>
            void me
              .save()
              .then(() => onJoin(invite))
              .then(dismiss)
          }
        >
          Join this space
        </AddButton>
        <LinkButton onClick={dismiss}>Not now</LinkButton>
      </div>
    </div>
  );
}
