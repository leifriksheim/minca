import { useRef, useState } from 'react';
import { useAccess, useAccount, useNode, useProfiles } from '@minca/react';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { comment } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { ago } from '@minca/ui/time';
import { PersonFace } from '../PersonFace';
import styles from './Comments.module.css';
import { Person } from '../Person';
import { peopleFrom, respondingTo } from '../../derive/people';
import { MentionField, MentionList, MentionText, useMentions } from './Mentions';

/**
 * `std.comment` on a record: a thread, oldest first, and a box to add to it.
 * "@" mentions someone, as in chat, so they can be told.
 */
export function Comments({
  space,
  target,
  targetAuthor,
  comments,
}: {
  space: SpaceSummary;
  target: string;
  /** Who wrote what is commented on, told through `respondingTo` */
  targetAuthor: string | null;
  comments: ReadonlyArray<NodeRecord>;
}) {
  const node = useNode();
  const { did: me } = useAccount();
  const people = peopleFrom(useProfiles(space.id));
  const access = useAccess(space.id);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const members = access?.members.map((m) => m.did);
  const mention = useMentions({ draft, setDraft, people, members, me, input });
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <section aria-label="Comments">
      <h3>Comments {comments.length > 0 && <small>{comments.length}</small>}</h3>
      {sorted.map((c) => (
        <div key={c.key} className="row">
          <PersonFace did={c.root ?? c.author} size={26} />
          <div className={`truncate ${styles.text}`}>
            <small>
              <strong>
                <Person did={c.root} />
              </strong>{' '}
              · {ago(c.createdAt)}
            </small>
            <p>
              <MentionText text={textIn(c) ?? ''} mentions={mentionsIn(c)} people={people} />
            </p>
          </div>
        </div>
      ))}
      {space.writable && (
        <MentionList
          suggestions={mention.suggestions}
          choice={mention.choice}
          people={people}
          onPick={mention.pick}
        />
      )}
      {space.writable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            const mentions = mention.take(text);
            void node.records.put(
              space.id,
              comment.name,
              { text, ...(mentions.length ? { mentions } : {}), ...respondingTo(targetAuthor, me) },
              { links: [{ rel: 'about', to: target }] },
            );
          }}
          className="row"
        >
          <MentionField
            input={input}
            marked={mention.marked}
            value={draft}
            onChange={mention.onChange}
            onSelect={mention.onSelect}
            onKeyDown={mention.onKeyDown}
            placeholder="Write a comment… @ to mention someone"
            aria-label="Write a comment"
          />
          <button type="submit" data-intent="primary" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}

/** Whom a comment mentions */
function mentionsIn(record: NodeRecord): string[] {
  const mentions = bodyOf(record).mentions;
  return Array.isArray(mentions) ? mentions.filter((did) => typeof did === 'string') : [];
}

/** What a comment says */
function textIn(record: NodeRecord): string | null {
  const text = bodyOf(record).text;
  return typeof text === 'string' ? text : null;
}
