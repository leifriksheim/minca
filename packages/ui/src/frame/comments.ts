/**
 * `std.comment` on a record, the way the app shows it: a thread, oldest
 * first, and a box to add to it, where "@" mentions someone so they can be
 * told, "+" (or typing "/") shares something from the space or, when the
 * app has `std.file`, attaches files, kept about the comment, and 🙂 adds an emoji. A screen whose
 * app names `std.comment` among its collections can use it.
 */
import { useState } from 'preact/hooks';
import { ago } from '../time';
import { attach, Attachments } from './attachments';
import type { ScreenRecord } from './minca';
import { useCan, usePeople, useRecords } from './hooks';
import { html } from './html';
import { MentionInput, MentionText, mentionsIn } from './mentions';
import { AddMenu, EmojiPicker } from './menus';
import { Avatar, Person } from './people';
import { recordTitle } from './record';
import { Shared, Sharing, useShare } from './share';
import { Icon } from './shapes';

const COMMENT = 'std.comment';
const FILE = 'std.file';

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
  // Files picked to go with the next comment
  const [files, setFiles] = useState<File[]>([]);
  const mayAttach = minca.collections.includes(FILE);

  const send = () => {
    const text =
      draft.trim() ||
      (share.sharing ? recordTitle(share.sharing) : '') ||
      files.map((file) => file.name).join(', ');
    if (!text) return;
    const links = [{ rel: 'about', to: about.key }, ...share.links];
    setError(null);
    // Only who the person named: a shared record's title is someone else's words.
    const mentions = mentionsIn(draft, people);
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
      .then(async (comment) => {
        setDraft('');
        share.clear();
        const sending = files;
        setFiles([]);
        if (sending.length) await attach(comment.key, sending);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return html`<section aria-label="Comments">
    <h3>Comments ${comments?.length ? html`<small>${comments.length}</small>` : ''}</h3>
    ${(comments ?? []).map(
      (c) =>
        html`<div class="comment" key=${c.key}>
          <${Avatar} did=${c.createdBy ?? ''} size=${26} round />
          <div>
            <div>
              <${Person} did=${c.createdBy ?? ''} face=${false} />
              <small>· ${ago(c.createdAt)}</small>
            </div>
            <p class="comment-text"><${MentionText} text=${c.body.text ?? ''} /></p>
            <${Shared} from=${c} />
            ${mayAttach && html`<${Attachments} about=${c.key} />`}
          </div>
        </div>`,
    )}
    ${
      mayComment &&
      html`<form
        class="stack"
        data-gap="tight"
        onSubmit=${(event: Event) => {
          event.preventDefault();
          send();
        }}
      >
        ${
          (share.sharing || files.length > 0) &&
          html`<div class="row">
            ${share.sharing && html`<${Sharing} share=${share} />`}
            ${files.map(
              (file, i) =>
                html`<span class="tag" key=${i}>
                  <span class="truncate">${file.name}</span>
                  <button
                    type="button"
                    data-intent="ghost"
                    data-icon
                    aria-label=${`Don't attach ${file.name}`}
                    onClick=${() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <${Icon} name="close" />
                  </button>
                </span>`,
            )}
          </div>`
        }
        <div class="composer">
          <${AddMenu}
            onShare=${() => void share.pick()}
            onFiles=${mayAttach ? (picked: File[]) => setFiles([...files, ...picked]) : null}
          />
          <${MentionInput}
            value=${draft}
            onChange=${(next: string) => setDraft(share.typed(draft, next))}
            placeholder="Write a comment…"
            aria-label="Write a comment"
          />
          <div class="composer-end">
            <${EmojiPicker} onPick=${(emoji: string) => setDraft(draft + emoji)} />
            <button
              type="submit"
              data-intent="primary"
              data-icon
              aria-label="Send"
              disabled=${!draft.trim() && !share.sharing && files.length === 0}
            >
              <${Icon} name="send" />
            </button>
          </div>
        </div>
      </form>`
    }
    ${(error ?? share.error) && html`<p role="alert">${error ?? share.error}</p>`}
  </section>`;
}
