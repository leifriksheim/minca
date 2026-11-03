import { Modal } from '@minca/app-shared/Modal';
import { AppIcon } from './AppIcon';
import type { AppEntry } from './entries';

/**
 * Which of the apps that show a kind of record to open one in, asked when
 * more than one does, the way a phone asks which app opens a link.
 */
export function OpenWith({
  apps,
  onChoose,
  onClose,
}: {
  apps: ReadonlyArray<AppEntry>;
  onChoose: (app: AppEntry) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Open with" onClose={onClose}>
      <ul role="list">
        {apps.map((app) => (
          <li key={app.id}>
            <button type="button" data-intent="open" className="row" onClick={() => onChoose(app)}>
              <AppIcon app={app} size={28} />
              <span className="stack" data-gap="tight">
                <strong>{app.title}</strong>
                {app.description && <small className="truncate">{app.description}</small>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
