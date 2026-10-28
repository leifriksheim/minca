/**
 * `std.comment` on a record, the way the app shows it: a thread, oldest
 * first, and a box to add to it, where "@" mentions someone so they can be
 * told and "/" shares something from the space. A screen whose app names
 * `std.comment` among its collections can use it.
 */
import { useState } from 'preact/hooks';
import { ago } from '../time';
import type { ScreenRecord } from './minca';
import { useCan, usePeople, useRecords } from './hooks';
import { html } from './html';
import { MentionInput, MentionText, mentionsIn } from './mentions';
import { Avatar, Person } from './people';
import { recordTitle } from './record';
import { Shared, Sharing, useShare } from './share';

const COMMENT = 'std.comment';

interface CommentBody {
  readonly text?: string;
}

/** The comments on a record, and a box to add one */
export function Comments({ about }: { about: Pick<ScreenRecord, 'key' | 'createdBy'> }) {
  const comments = useRecords<CommentBody>(COMMENT, { 'link:about': about.key });
  const mayComment = useCan('create', COMMENT);
  const people = usePeople();
  const me = minca.me.did;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const share = useShare();

  const send = () => {
    const text = draft.trim() || (share.sharing ? recordTitle(share.sharing) : '');
    if (!text) return;
    const links = [{ rel: 'about', to: about.key }, ...share.links];
    setDraft('');
    share.clear();
    setError(null);
    const mentions = mentionsIn(text, people);
    minca
      .put(
        COMMENT,
        {
          text,
          ...(mentions.length ? { mentions } : {}),
          ...(about.createdBy && about.createdBy !== me ? { respondingTo: about.createdBy } : {}),
        },
        { links },
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return html`<section class="stack comments" aria-label="Comments" style="gap: 14px">
    <h3>Comments ${comments?.length ? html`<span class="faint">${comments.length}</span>` : ''}</h3>
    ${(comments ?? []).map(
      (c) =>
        html`<div class="row" key=${c.key} style="align-items: flex-start; gap: 10px">
          <${Avatar} did=${c.createdBy ?? ''} size=${26} round />
          <div style="min-width: 0">
            <div>
              <${Person} did=${c.createdBy ?? ''} face=${false} />
              <span class="faint">· ${ago(c.createdAt)}</span>
            </div>
            <p class="comment-text"><${MentionText} text=${c.body.text ?? ''} /></p>
            <${Shared} from=${c} />
          </div>
        </div>`,
    )}
    ${
      mayComment &&
      html`<form
        class="stack"
        style="gap: 6px"
        onSubmit=${(event: Event) => {
          event.preventDefault();
          send();
        }}
      >
        ${share.sharing && html`<div class="row"><${Sharing} share=${share} /></div>`}
        <div class="row">
          <button
            type="button"
            data-icon
            aria-label="Share something from this space"
            title="Share something from this space"
            onClick=${() => void share.pick()}
          >
            /
          </button>
          <${MentionInput}
            value=${draft}
            onChange=${(next: string) => setDraft(share.typed(draft, next))}
            placeholder="Write a comment… @ to mention, / to share"
            aria-label="Write a comment"
          />
          <button type="submit" data-variant="primary" disabled=${!draft.trim() && !share.sharing}>
            Send
          </button>
        </div>
      </form>`
    }
    ${(error ?? share.error) && html`<p class="error">${error ?? share.error}</p>`}
  </section>`;
}
