import { useState } from 'react';
import { useNode, useAccount } from '@minca/react';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { reaction } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { respondingTo } from '../../derive/people';
import styles from './Reactions.module.css';

const QUICK = ['👍', '❤️', '🎉', '😂', '👀', '🙏'];

/** `std.reaction` on a record: each emoji with its count, yours highlighted. */
export function Reactions({
  space,
  target,
  targetAuthor,
  reactions,
}: {
  space: SpaceSummary;
  target: string;
  /** Who wrote what is reacted to, told through `respondingTo` */
  targetAuthor: string | null;
  reactions: ReadonlyArray<NodeRecord>;
}) {
  const node = useNode();
  const { did: rootDid } = useAccount();
  const [picking, setPicking] = useState(false);
  const byEmoji = new Map<string, NodeRecord[]>();
  for (const r of reactions) {
    const emoji = bodyOf(r).emoji;
    if (typeof emoji === 'string' && emoji) byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), r]);
  }

  const toggle = (emoji: string) => {
    setPicking(false);
    const mine = byEmoji.get(emoji)?.find((r) => r.root === rootDid);
    void (mine
      ? node.records.delete(space.id, mine.key)
      : node.records.put(
          space.id,
          reaction.name,
          { emoji, ...respondingTo(targetAuthor, rootDid) },
          { links: [{ rel: 'about', to: target }] },
        ));
  };

  return (
    <div className={`row ${styles.reactions}`} data-gap="tight" aria-label="Reactions">
      {[...byEmoji].map(([emoji, list]) => {
        const mine = list.some((r) => r.root === rootDid);
        return (
          <button
            key={emoji}
            onClick={() => toggle(emoji)}
            disabled={!space.writable}
            aria-pressed={mine}
            aria-label={`${emoji} ${list.length}${mine ? ', yours' : ''}`}
          >
            <span>{emoji}</span>
            {list.length}
          </button>
        );
      })}
      {space.writable && (
        <button data-intent="ghost" onClick={() => setPicking((was) => !was)} aria-label="Add a reaction">
          ☺︎+
        </button>
      )}
      {picking && (
        <menu role="menu" className={styles.picker}>
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              role="menuitem"
              data-icon
              onClick={() => toggle(emoji)}
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </menu>
      )}
    </div>
  );
}

/** 👍 3 · ❤️ 1 — a record's reactions in a few characters, for a list row */
export function reactionSummary(reactions: ReadonlyArray<NodeRecord> | number | undefined): string {
  if (typeof reactions !== 'object' || reactions.length === 0) return '';
  const counts = new Map<string, number>();
  for (const r of reactions) {
    const emoji = bodyOf(r).emoji;
    if (typeof emoji === 'string' && emoji) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  }
  return [...counts]
    .slice(0, 3)
    .map(([emoji, n]) => `${emoji} ${n}`)
    .join('  ');
}
