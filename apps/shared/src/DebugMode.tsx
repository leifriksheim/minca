/**
 * Debug mode: `?debug` in any address turns it on, on this device, until
 * `?debug=off` or its own Turn off. A strip along the bottom shows how the
 * page is doing; a tap opens the full report (`debugReport.ts`), to copy and
 * paste wherever it helps.
 *
 * It draws in a root of its own, beside the app's, so it still works when
 * the app is stuck or has crashed.
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { askWorkers, logEntries, loadedAt } from './debugLog';
import { debugReport, type DebugDetails } from './debugReport';
import styles from './DebugMode.module.css';

const KEPT = 'minca:debug';

/** Whether debug mode is on here, after taking up what the address says */
function debugModeOn(): boolean {
  try {
    const asked = new URLSearchParams(location.search).get('debug');
    if (asked !== null) {
      if (['0', 'off', 'false', 'no'].includes(asked.toLowerCase())) localStorage.removeItem(KEPT);
      else localStorage.setItem(KEPT, 'on');
    }
    return localStorage.getItem(KEPT) === 'on';
  } catch {
    return new URLSearchParams(location.search).has('debug');
  }
}

interface DebugModeOptions {
  /** The app's name, at the top of the report */
  readonly app: string;
  /** What the app says about itself: its connection, its account, its node. No secrets. */
  readonly details?: DebugDetails;
}

/** Shows debug mode, if it is on: call once, as the app starts */
export function mountDebugMode(options: DebugModeOptions): void {
  if (!debugModeOn()) return;
  askWorkers();
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<DebugMode {...options} />);
}

const build: string = import.meta.env.VITE_MINCA_BUILD ?? 'dev';

function DebugMode({ app, details }: DebugModeOptions) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(loadedAt);
  // The strip's figures move on their own: the time since loading, and the last thing said.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const entries = logEntries();
  // Warnings and errors, which are what usually tells.
  const problems = entries.filter((entry) => entry.level === 'error' || entry.level === 'warn').length;
  const last = entries.at(-1);
  const seconds = Math.round((now - loadedAt) / 1000);

  if (open) return <DebugScreen app={app} details={details} onClose={() => setOpen(false)} />;
  return (
    <button type="button" className={styles.strip} onClick={() => setOpen(true)}>
      <strong>Debug</strong>
      <span>{seconds}s</span>
      {problems > 0 && (
        <span data-tone="danger">{problems === 1 ? '1 problem' : `${problems} problems`}</span>
      )}
      <span className={styles.last}>{last ? last.text.split('\n')[0] : 'nothing logged yet'}</span>
    </button>
  );
}

function DebugScreen({ app, details, onClose }: DebugModeOptions & { onClose: () => void }) {
  const [report, setReport] = useState('Gathering…');
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const text = useRef<HTMLPreElement>(null);

  const refresh = () => {
    askWorkers();
    setCopied(null);
    // The workers' answers come over a channel: give them a moment.
    setTimeout(() => void debugReport(app, build, details).then(setReport), 300);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  useEffect(refresh, []);

  const copy = () => {
    // Straight from the tap, as a selection copied: what an iPhone's web views allow, where the
    // clipboard API is often refused. Then the clipboard API; then the text selected, to copy by hand.
    if (copyBySelection(report)) return setCopied('yes');
    const failed = () => {
      select();
      setCopied('no');
    };
    if (navigator.clipboard) void navigator.clipboard.writeText(report).then(() => setCopied('yes'), failed);
    else failed();
  };
  // The phone's own share sheet, which can copy too, or send the report straight on.
  const share =
    typeof navigator.share === 'function'
      ? () => void navigator.share({ title: `Minca debug report: ${app}`, text: report }).catch(() => {})
      : null;
  const select = () => {
    const range = document.createRange();
    if (!text.current) return;
    range.selectNodeContents(text.current);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  const turnOff = () => {
    try {
      localStorage.removeItem(KEPT);
    } catch {
      // Nothing kept, nothing to forget.
    }
    location.reload();
  };

  return (
    <div className={styles.screen} role="dialog" aria-label="Debug report">
      <header>
        <button type="button" data-intent="primary" onClick={copy}>
          {copied === 'yes' ? 'Copied' : copied === 'no' ? 'Selected: copy it' : 'Copy all'}
        </button>
        {share && (
          <button type="button" onClick={share}>
            Share
          </button>
        )}
        <button type="button" onClick={refresh}>
          Refresh
        </button>
        <button type="button" data-intent="ghost" onClick={turnOff}>
          Turn off
        </button>
        <button type="button" data-intent="ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <pre ref={text}>{report}</pre>
    </div>
  );
}

/**
 * Copies `text` by selecting it in a field out of sight and asking the
 * browser to copy, inside the tap that asked. Says whether it did.
 */
function copyBySelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  // Read-only, so an iPhone neither opens its keyboard nor zooms in on it.
  field.readOnly = true;
  field.className = styles.offscreen ?? '';
  document.body.append(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    // eslint-disable-next-line typescript/no-deprecated -- the one copy an iPhone's web views reliably allow
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    getSelection()?.removeAllRanges();
  }
}
