import { Loader } from './Loader';
import { Wordmark } from './Wordmark';
import css from './Opening.module.css';

/**
 * The whole window while an account opens: the wordmark at the top, and the
 * loader in the middle over what is being waited for. It only draws; whoever
 * shows it decides when the wait is over.
 */
export function Opening({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className={css.opening}>
      <Wordmark />
      <div className={css.middle} role="status">
        <Loader size={30} decorative />
        <h2>{title}…</h2>
        {detail && <small>{detail}</small>}
      </div>
    </main>
  );
}
