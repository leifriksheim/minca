import type { ReactNode } from 'react';
import { Modal } from '@minca/app-shared/Modal';
import { MCP_URL, addToClaude } from '@minca/app-shared/mcp';
import { Terminal } from '@minca/app-shared/Terminal';

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
      <p>Add Minca to Claude, then pick the spaces it may use at your account home.</p>
      <button data-intent="primary" onClick={() => window.open(addToClaude(), '_blank', 'noopener')}>
        Add to Claude ↗
      </button>
      <div className="stack">
        <p>Another AI app? Give it this address.</p>
        <Terminal text={MCP_URL} />
      </div>
      <div className="stack">
        <h3>Then just ask</h3>
        {then ?? (
          <p>
            In a new chat with your agent, say what you need in your own words: what’s new in a group, add an
            app, change one.
          </p>
        )}
      </div>
      <small>
        It writes as you, marked “via agent”, and can’t add people or change who may do what.{' '}
        <a href={GUIDE} target="_blank" rel="noreferrer">
          Other apps, step by step
        </a>
      </small>
    </Modal>
  );
}
