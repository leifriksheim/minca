import { Modal } from '@minca/app-shared/Modal';
import { palette, styles, ui } from '../../styles';
import { ToolIcon } from './ToolIcon';
import type { ToolEntry } from './entries';

/**
 * Which of the tools that show a kind of record to open one in, asked when
 * more than one does, the way a phone asks which tool opens a link.
 */
export function OpenWith({
  tools,
  onChoose,
  onClose,
}: {
  tools: ReadonlyArray<ToolEntry>;
  onChoose: (tool: ToolEntry) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Open with" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {tools.map((tool) => (
          <button key={tool.id} type="button" data-row onClick={() => onChoose(tool)} style={row}>
            <ToolIcon id={tool.id} size={28} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{tool.title}</span>
              {tool.description && (
                <span style={{ ...styles.faint, ...ui.ellipsis }}>{tool.description}</span>
              )}
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
