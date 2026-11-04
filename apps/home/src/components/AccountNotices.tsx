import { useMinca } from '@minca/react';
import { relayOnlyLocal, relayProblem } from '@minca/app-shared/relay';
import { PodChoice } from './PodChoice';

/**
 * What the account has to say, above whatever page is showing: a relay that
 * cannot be reached, a pod move waiting on an answer or just finished, and
 * anything that went wrong.
 */
export function AccountNotices() {
  const { auth, state } = useMinca();
  if (!auth || !state) return null;
  const { podChoice, moved, error, busy } = state;

  return (
    <>
      {/* Without a reachable relay nothing syncs, and the only symptom is a
          peer count that never moves. Better to say it than to look broken. */}
      {relayProblem() && (
        <aside data-tone="danger" className="stack">
          <strong>Peers cannot find each other</strong>
          <p>{relayProblem()}</p>
          <p>
            Your spaces still work, and still save. They just will not reach your other devices until this is
            set.
          </p>
        </aside>
      )}
      {!relayProblem() && relayOnlyLocal() && <small>{relayOnlyLocal()}</small>}

      {podChoice && (
        <PodChoice
          pod={podChoice.pod}
          contents={podChoice.contents}
          from={podChoice.from}
          loading={busy}
          error={error}
          onConfirm={(how) => void auth.confirmPod(how)}
          onCancel={() => auth.cancelPod()}
        />
      )}

      {!podChoice && error && (
        <aside data-tone="danger" className="stack">
          <strong>{error.message}</strong>
          {error.hint && <p>{error.hint}</p>}
        </aside>
      )}

      {moved && (
        <article>
          <strong>
            {moved.merged
              ? `Combined with the copy in the pod — ${moved.recordsAdded} new records, ${moved.spacesAdded} new spaces.`
              : `Moved into the pod — ${moved.spacesAdded} spaces, ${moved.recordsAdded} records.`}
          </strong>
          <small>
            {moved.from
              ? `“${moved.from}” still has its own copy. Minca won't use it any more — delete the folder yourself once you're sure you don't need it.`
              : "This browser still has its own copy. Nothing uses it now; remove it once you're happy the pod has everything."}
          </small>
          <div className="row">
            {!moved.from && (
              <button onClick={() => void auth.forgetBrowserCopy()}>Remove the browser copy</button>
            )}
            <button onClick={() => auth.dismissMoved()}>{moved.from ? 'Got it' : 'Keep it'}</button>
          </div>
        </article>
      )}
    </>
  );
}
