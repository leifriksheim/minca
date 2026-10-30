import type { ReactNode } from 'react';
import { Modal } from '@minca/app-shared/Modal';
import { useCopy } from '@minca/app-shared/action';
import { styles, palette, stack } from '../styles';
import { PrimaryButton } from './Buttons';

/** What people run: it finds the agents on their computer, and opens their account home to allow it */
const COMMAND = import.meta.env.VITE_MINCA_CONNECT ?? 'npx @minca/cli connect';
/** Every way to add Minca to an agent, by hand too, on the site */
const GUIDE = 'https://minca.social/mcp';

/**
 * Connecting an agent on a computer, as the site's MCP page has it: one command to paste, allowed at
 * the account home, and then you just ask. `then` says what to ask for; without it, anything.
 */
export function ConnectAgent({
  onClose,
  title = 'Connect your own agent',
  then,
}: {
  onClose: () => void;
  title?: string;
  then?: ReactNode;
}) {
  const { copied, copy } = useCopy();
  return (
    <Modal title={title} onClose={onClose} width={480}>
      <div style={stack(16)}>
        <p style={stepText}>
          Paste this in a terminal on your computer. It finds Claude, Cursor and the other AI apps there, and
          you allow it in your account home.
        </p>
        <div style={commandBox}>
          <code style={commandText}>{COMMAND}</code>
          <PrimaryButton
            onClick={() => copy(COMMAND)}
            style={{ width: 'auto', height: 32, padding: '0 14px', fontSize: 13 }}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </PrimaryButton>
        </div>
        <div style={stack(8)}>
          <strong style={{ fontSize: 15, color: palette.ink.strong }}>Then just ask</strong>
          {then ?? (
            <p style={stepText}>
              In a new chat with your agent, say what you need in your own words: what’s new in a group, add a
              tool, change one.
            </p>
          )}
        </div>
        <p style={{ ...styles.quiet, fontSize: 13 }}>
          It writes as you, marked “via agent”, and can’t add people or change who may do what.{' '}
          <a href={GUIDE} target="_blank" rel="noreferrer" style={{ color: palette.ink.body }}>
            Other ways to set it up
          </a>
        </p>
      </div>
    </Modal>
  );
}

export const stepText = { fontSize: 14, lineHeight: 1.55, color: palette.ink.body } as const;

const commandBox = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 8px 8px 14px',
  borderRadius: palette.radius.md,
  background: palette.surface.sunken,
  fontFamily: palette.mono,
} as const;
const commandText = {
  flex: 1,
  minWidth: 0,
  overflowWrap: 'anywhere',
  fontSize: 12.5,
  lineHeight: 1.5,
  color: palette.ink.strong,
} as const;
