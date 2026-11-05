import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAsync, useConnection, useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { QrCode } from '@minca/app-shared/QrCode';
import { useCopy } from '@minca/app-shared/action';
import { shortUsername } from '@minca/app-shared/usernames';
import { inboxLink, usernameLink } from '../contacts';
import { useWorkspace } from '../workspace';
import styles from './NewSheet.module.css';
import type { ShapeKind } from '@minca/ui/shapes';
import { Options } from './Options';
import { SpaceDialog } from './SpaceList';

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
  group: { shape: 'group', title: 'New group', detail: 'Name it, then add people' },
  message: { shape: 'scallop', title: 'New contact', detail: 'Find someone by their username' },
  share: { shape: 'signal', title: 'Share your link', detail: 'So people can add you' },
  join: { shape: 'pass', title: 'Join with a link', detail: 'Someone sent you an invite' },
};

/**
 * The "+" on the home screen: one place to start anything, a new group and a
 * new contact first, whichever the tab you're on is for leading. A contact
 * starts from finding them in People; a group from naming it, then adding people.
 */
export function NewSheet({ on, onClose }: { on: 'people' | 'groups'; onClose: () => void }) {
  const navigate = useNavigate();
  const { create, join } = useWorkspace();
  const [step, setStep] = useState<'menu' | 'share'>('menu');
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);
  const order: ReadonlyArray<Start> =
    on === 'people' ? ['message', 'group', 'share', 'join'] : ['group', 'message', 'share', 'join'];

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
  const { connection } = useConnection();
  const found = useAsync(() => node.inbox.get(), [node]);
  const inbox = found.status === 'done' ? found.value : null;
  const { copied, copy } = useCopy();
  const username = inbox?.username;
  const link = username ? usernameLink(username) : inbox ? inboxLink(inbox.code) : null;

  return (
    <Modal title="Share your link" onClose={onClose}>
      {found.status === 'loading' ? null : link ? (
        <div className={`stack ${styles.share}`}>
          <article>
            <QrCode text={link} label="QR code to add you" size={184} />
          </article>
          {username && <h2>{shortUsername(username)}</h2>}
          <p>Anyone who scans it or opens the link can ask to be your contact. You choose who gets in.</p>
          {username ? (
            <button data-intent="primary" onClick={() => void shareUsername(username, copy)}>
              {copied ? 'Link copied' : 'Share link'}
            </button>
          ) : (
            <button data-intent="primary" onClick={() => copy(link)}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
        </div>
      ) : (
        <>
          <p>
            Pick a username first: it’s what your link leads to, and what people type to find you. It’s kept
            with your account, so every app finds you by it.
          </p>
          <button
            data-intent="ghost"
            onClick={() => {
              onClose();
              connection.openHome();
            }}
          >
            Pick a username
          </button>
        </>
      )}
    </Modal>
  );
}
