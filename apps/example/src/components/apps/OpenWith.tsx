import { Modal } from '@minca/app-shared/Modal';
import { palette, styles, ui } from '../../styles';
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
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {apps.map((app) => (
          <button key={app.id} type="button" data-row onClick={() => onChoose(app)} style={row}>
            <AppIcon id={app.id} size={28} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{app.title}</span>
              {app.description && <span style={{ ...styles.faint, ...ui.ellipsis }}>{app.description}</span>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 8px',
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  textAlign: 'left' as const,
  fontSize: 14,
  width: '100%',
};
