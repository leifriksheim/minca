import { useState } from 'react';
import type { Place, PodContents } from '@minca/core/session';
import type { AuthError } from '@minca/auth';
import { Choices } from '@minca/app-shared/Choices';
import { Modal } from '@minca/app-shared/Modal';

/**
 * Asked after picking a pod while signed in, before anything changes.
 *
 * Two situations, told apart by what the pod already holds:
 *
 * - **The pod has never seen this account.** There is only one sensible
 *   thing to do — bring it in — so it is a confirmation, not a choice.
 * - **The pod already has this account.** Now there are two copies, and the
 *   person decides: combine them (safe: records are versioned, so nothing is
 *   overwritten), or just switch to the pod's copy and leave this one be.
 *
 * Other accounts in the pod are mentioned, because "will this touch my
 * partner's account?" is the question people actually have, and never touched.
 */
export function PodChoice({
  pod,
  contents,
  from,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  pod: Place;
  contents: PodContents;
  from: Place;
  loading: boolean;
  error: AuthError | null;
  onConfirm: (how: 'combine' | 'switch') => void;
  onCancel: () => void;
}) {
  const [how, setHow] = useState<'combine' | 'switch'>('combine');
  const podName = pod.directory?.name ?? 'this pod';
  const here =
    from.kind === 'folder' ? `in “${from.directory?.name ?? 'your current pod'}”` : 'in this browser';
  const others =
    contents.others > 0
      ? ` The pod also has ${contents.others} other ${contents.others === 1 ? 'account' : 'accounts'} — ${contents.others === 1 ? 'it' : 'they'} won't be touched.`
      : '';

  if (!contents.account) {
    return (
      <Modal title={`Move to “${podName}”?`} onClose={onCancel}>
        <p>
          Your account and all its spaces will be copied into this pod, and Minca will keep your data there
          from now on.
          {others}
        </p>
        <small>Nothing is deleted. The copy {here} stays until you remove it.</small>
        {error && <p role="alert">{error.message}</p>}
        <Actions
          loading={loading}
          confirm="Move to pod"
          busy="Moving…"
          onConfirm={() => onConfirm('combine')}
          onCancel={onCancel}
        />
      </Modal>
    );
  }

  return (
    <Modal title={`“${podName}” already has your account`} onClose={onCancel}>
      <p>
        What should happen to the data {here}?{others}
      </p>
      <Choices
        label="What to do with your data"
        picked={how}
        onPick={setHow}
        disabled={loading}
        options={[
          {
            value: 'combine',
            shape: 'stack',
            colour: 'sage',
            title: 'Combine them',
            tag: 'Recommended',
            detail: `Bring everything ${here} into “${podName}”. Nothing is overwritten or lost — an item edited in both places is settled the same way your devices settle it when they sync.`,
          },
          {
            value: 'switch',
            shape: 'arch',
            colour: 'peach',
            title: 'Use the pod as it is',
            detail: `Switch to the pod's copy and bring nothing over. Anything only ${here} stays behind.`,
          },
        ]}
      />
      {error && <p role="alert">{error.message}</p>}
      <Actions
        loading={loading}
        confirm="Continue"
        busy={how === 'combine' ? 'Combining…' : 'Switching…'}
        onConfirm={() => onConfirm(how)}
        onCancel={onCancel}
      />
    </Modal>
  );
}

function Actions({
  loading,
  confirm,
  busy,
  onConfirm,
  onCancel,
}: {
  loading: boolean;
  confirm: string;
  busy: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="row" data-spread>
      <button onClick={onCancel} disabled={loading}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={loading} data-intent="primary">
        {loading ? busy : confirm}
      </button>
    </div>
  );
}
