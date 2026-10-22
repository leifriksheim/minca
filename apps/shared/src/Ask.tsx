import { createRoot } from 'react-dom/client';
import { Modal } from './Modal';
import { styles } from './styles';
import { accent, ink } from '@minca/ui/tokens';

export interface Asking {
  /** Above the question; "Are you sure?" by default */
  readonly title?: string;
  /** What going ahead does, as the button says it: "Delete", "Leave" */
  readonly yes?: string;
  readonly no?: string;
  /** Going ahead loses something: the button says so in red */
  readonly danger?: boolean;
}

/**
 * Asks before doing something, in a dialog of the app's own. Resolves true to
 * go ahead.
 *
 * Instead of `confirm()`: the desktop app's WebKit window shows no native
 * dialogs, and answers every `confirm()` with false, so whatever waited on one
 * silently did nothing there.
 */
export function ask(question: string, options: Asking = {}): Promise<boolean> {
  const document = globalThis.document;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return new Promise((resolve) => {
    let done = false;
    const answer = (yes: boolean) => {
      if (done) return;
      done = true;
      resolve(yes);
      // Not while the click that answered is still being handled by this root.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(<Ask question={question} options={options} answer={answer} />);
  });
}

function Ask({
  question,
  options,
  answer,
}: {
  question: string;
  options: Asking;
  answer: (yes: boolean) => void;
}) {
  return (
    <Modal title={options.title ?? 'Are you sure?'} onClose={() => answer(false)} width={420}>
      <p style={{ fontSize: 14, lineHeight: 1.5 }}>{question}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {/* First, so it has the focus: Enter alone never does the thing asked about. */}
        <button type="button" onClick={() => answer(false)} data-variant="quiet" style={both}>
          {options.no ?? 'Cancel'}
        </button>
        <button
          type="button"
          onClick={() => answer(true)}
          data-variant={options.danger ? undefined : 'primary'}
          style={{ ...both, ...(options.danger ? danger : primary) }}
        >
          {options.yes ?? 'Continue'}
        </button>
      </div>
    </Modal>
  );
}

const both = { ...styles.smallButton, height: 36, width: 'auto', padding: '0 16px', fontSize: 14 };
const primary = { backgroundColor: accent.base, borderColor: accent.base, color: ink.inverse };
const danger = { backgroundColor: accent.danger, borderColor: accent.danger, color: ink.inverse };
