import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccount, useAsync, useConnection, useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { QrCode } from '@minca/app-shared/QrCode';
import { useCopy } from '@minca/app-shared/action';
import { shortUsername } from '@minca/app-shared/usernames';
import { inboxLink, usernameLink } from '../contacts';
import { useWorkspace } from '../workspace';
import { palette, styles } from '../styles';
import { AddButton, QuietButton } from './Buttons';
import type { ShapeKind } from '@minca/ui/shapes';
import { Options } from './Options';
import { SpaceDialog } from './SpaceList';
import { openAccountHome } from './AccountMenu';

const { ink, surface, radius } = palette;

/** Shares a username the way a phone shares anything; elsewhere its link is copied */
async function shareUsername(username: string, copy: (text: string) => void): Promise<void> {
  const url = usernameLink(username);
  if (globalThis.navigator.share)
    await globalThis.navigator.share({ title: 'Add me on Minca', text: username, url }).catch(() => {});
  else copy(url);
}

/** What the "+" on the home screen starts */
type Start = 'message' | 'group' | 'share' | 'join';

const STARTS: Record<Start, { shape: ShapeKind; title: string; detail: string }> = {
  message: { shape: 'scallop', title: 'Message someone', detail: 'A contact, or anyone by their username' },
  group: { shape: 'group', title: 'New group', detail: 'Name it, then add people' },
  share: { shape: 'signal', title: 'Share your link', detail: 'So people can add you' },
  join: { shape: 'pass', title: 'Join with a link', detail: 'Someone sent you an invite' },
};

/**
 * The "+" on the home screen: one place to start anything, with what the tab
 * you're on is for first. A chat with someone starts from finding them in
 * People; a group from naming it, then adding people.
 */
export function NewSheet({ on, onClose }: { on: 'people' | 'groups'; onClose: () => void }) {
  const navigate = useNavigate();
  const { create, join } = useWorkspace();
  const [step, setStep] = useState<'menu' | 'share'>('menu');
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);
  const order: ReadonlyArray<Start> =
    on === 'people' ? ['message', 'share', 'group', 'join'] : ['group', 'join', 'message', 'share'];

  const start = (what: Start) => {
    if (what === 'message') {
      onClose();
      void navigate({ to: '/people', state: { find: true } });
    } else if (what === 'share') setStep('share');
    else setDialog(what === 'group' ? 'new' : 'join');
  };

  if (dialog) return <SpaceDialog initial={dialog} onClose={onClose} onCreate={create} onJoin={join} />;
  if (step === 'share') return <ShareMe onClose={onClose} />;
  return (
    <Modal title="Start something" onClose={onClose}>
      <Options
        label="Start something"
        options={order.map((what) => ({ value: what, ...STARTS[what] }))}
        onPick={start}
      />
    </Modal>
  );
}

/** Your link to hand out, and its QR code to scan: your username's when you have one, else your inbox's */
function ShareMe({ onClose }: { onClose: () => void }) {
  const node = useNode();
  const account = useAccount();
  const { state } = useConnection();
  const found = useAsync(() => node.inbox.get(), [node]);
  const inbox = found.status === 'done' ? found.value : null;
  const { copied, copy } = useCopy();
  const username = inbox?.username;
  const link = username ? usernameLink(username) : inbox ? inboxLink(inbox.code) : null;

  return (
    <Modal title="Share your link" onClose={onClose}>
      {found.status === 'loading' ? null : link ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <div style={{ padding: 12, borderRadius: radius.lg, border: `1px solid ${surface.rule}` }}>
            <QrCode text={link} label="QR code to add you" size={184} />
          </div>
          {username && (
            <strong style={{ ...styles.appTitle, fontSize: 22 }}>{shortUsername(username)}</strong>
          )}
          <p style={{ fontSize: 14, color: ink.muted, textAlign: 'center', lineHeight: 1.5 }}>
            Anyone who scans it or opens the link can ask to be your contact. You choose who gets in.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {username ? (
              <AddButton onClick={() => void shareUsername(username, copy)} style={{ height: 40 }}>
                {copied ? 'Link copied' : 'Share link'}
              </AddButton>
            ) : (
              <AddButton onClick={() => copy(link)} style={{ height: 40 }}>
                {copied ? 'Copied' : 'Copy link'}
              </AddButton>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 14, color: ink.muted, lineHeight: 1.5 }}>
            Pick a username first: it’s what your link leads to, and what people type to find you. It’s kept
            with your account, so every app finds you by it.
          </p>
          <QuietButton
            onClick={() => {
              onClose();
              openAccountHome(state.home, account.did);
            }}
            style={{ alignSelf: 'flex-start' }}
          >
            Pick a username
          </QuietButton>
        </div>
      )}
    </Modal>
  );
}
