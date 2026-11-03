import { useCopy } from './action';
import styles from './Terminal.module.css';

/** On the dark box: words, flags dimmed, addresses and the prompt green */
const kindOf = (word: string) =>
  word.startsWith('--') ? 'flag' : /^https?:\/\//.test(word) ? 'address' : undefined;

/**
 * A line to paste, on one dark row with a copy icon at its end: a command gets a `$` before it, an
 * address goes as it is. The site's MCP page and the apps' "Connect an agent" both use it.
 */
export function Terminal({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  const command = !/^https?:\/\//.test(text);
  return (
    <div className={styles.terminal}>
      <code>
        {command && <span data-kind="prompt">$ </span>}
        {text.split(' ').map((word, i) => (
          <span key={i} data-kind={kindOf(word)}>
            {i > 0 && ' '}
            {word}
          </span>
        ))}
      </code>
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        data-intent="quiet"
        data-icon
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

const Copy = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden
  >
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </svg>
);

const Check = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    aria-hidden
  >
    <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
