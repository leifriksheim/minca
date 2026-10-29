import { useRef, useState } from 'react';
import { useAccess, useAccount, useNode, useProfiles } from '@minca/react';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { comment } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { ago } from '@minca/ui/time';
import { PersonAvatar } from './PersonAvatar';
import { styles, palette, hstack, stack } from '../../styles';
import { Person } from '../Person';
import { peopleFrom, respondingTo } from '../../derive/people';
import { MentionField, MentionList, MentionText, useMentions } from './Mentions';
import { AddButton } from '../Buttons';

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
    <section aria-label="Comments" style={stack(14)}>
      <h3 style={styles.sectionTitle}>
        Comments{' '}
        {comments.length > 0 && (
          <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{comments.length}</span>
        )}
      </h3>
      {sorted.map((c) => (
        <div key={c.key} style={hstack(10)}>
          <PersonAvatar spaceId={space.id} did={c.root ?? c.author} size={26} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <Person did={c.root} style={{ fontWeight: 600, color: palette.ink.strong }} />
              <span style={{ color: palette.ink.faint }}> · {ago(c.createdAt)}</span>
            </div>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: palette.ink.body,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
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
          style={{
            border: `1px solid ${palette.surface.line}`,
            borderRadius: palette.radius.md,
            overflow: 'hidden',
          }}
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
          style={hstack(8)}
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
            style={styles.input}
          />
          <AddButton type="submit" disabled={!draft.trim()}>
            Send
          </AddButton>
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
