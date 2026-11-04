import { useState } from 'react';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { useNode } from '@minca/react';
import { useAction } from '@minca/app-shared/action';
import { Modal } from '@minca/app-shared/Modal';
import { saveSettings, type LauncherApp } from './launcher';

/**
 * An app's settings, for someone who may add apps: what the app asks for, like
 * an API key, filled in once for everyone in the space. Reached from the app's
 * row while arranging the space's apps (`AppsView`); nobody else is asked.
 */
export function AppSettings({
  space,
  record,
  onClose,
}: {
  space: SpaceSummary;
  record: NodeRecord<LauncherApp>;
  onClose: () => void;
}) {
  const node = useNode();
  const { run, busy, error } = useAction();
  const settings = record.body?.settings ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(settings.map((setting) => [setting.key, setting.value ?? ''])),
  );
  const save = () =>
    run(async () => {
      await saveSettings(node, space.id, record, values);
      onClose();
    });

  return (
    <Modal title={`${record.body?.title ?? 'App'} settings`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="stack"
        data-gap="loose"
      >
        <small>What you fill in here is for everyone in {space.name}: they won't be asked.</small>
        {settings.map((setting) => (
          <label key={setting.key}>
            {setting.title}
            <input
              type="text"
              value={values[setting.key] ?? ''}
              onChange={(event) => setValues((was) => ({ ...was, [setting.key]: event.target.value }))}
              spellCheck={false}
              autoComplete="off"
            />
            {setting.description && <small>{setting.description}</small>}
          </label>
        ))}
        {error && <p role="alert">{error}</p>}
        <button type="submit" data-intent="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Modal>
  );
}
