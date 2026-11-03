import type { ReactNode } from 'react';
import { Modal } from '@minca/app-shared/Modal';
import { MCP_URL, addToClaude } from '@minca/app-shared/mcp';
import { Terminal } from '@minca/app-shared/Terminal';
import { styles, palette, stack } from '../styles';
import { PrimaryButton } from './Buttons';

/** Every AI app, step by step, and keeping it on your own computer, on the site */
const GUIDE = 'https://minca.social/mcp';

/**
 * Connecting an AI app to Minca's MCP service, as the site's MCP page has it: one click for Claude,
 * the address for any other app, allowed at the account home, and then you just ask. `then` says
 * what to ask for; without it, anything.
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
  return (
    <Modal title={title} onClose={onClose} width={480}>
      <div style={stack(16)}>
        <p style={stepText}>Add Minca to Claude, then pick the spaces it may use at your account home.</p>
        <PrimaryButton onClick={() => window.open(addToClaude(), '_blank', 'noopener')}>
          Add to Claude ↗
        </PrimaryButton>
        <div style={stack(8)}>
          <p style={stepText}>Another AI app? Give it this address.</p>
          <Terminal text={MCP_URL} />
        </div>
        <div style={stack(8)}>
          <strong style={{ fontSize: 15, color: palette.ink.strong }}>Then just ask</strong>
          {then ?? (
            <p style={stepText}>
              In a new chat with your agent, say what you need in your own words: what’s new in a group, add
              an app, change one.
            </p>
          )}
        </div>
        <p style={{ ...styles.quiet, fontSize: 13 }}>
          It writes as you, marked “via agent”, and can’t add people or change who may do what.{' '}
          <a href={GUIDE} target="_blank" rel="noreferrer" style={{ color: palette.ink.body }}>
            Other apps, step by step
          </a>
        </p>
      </div>
    </Modal>
  );
}

export const stepText = { fontSize: 14, lineHeight: 1.55, color: palette.ink.body } as const;
