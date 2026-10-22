/**
 * "@" mentions, the way the app has them: typing "@" suggests the space's
 * people, a sent text names whom it mentions (a body's `mentions`, so they can
 * be told), and a shown text marks them.
 */
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Someone } from './minca';
import { usePeople } from './hooks';
import { html } from './html';
import { Avatar } from './people';

/** A run of text, and whom it mentions when it is an "@Name" */
interface Segment {
  readonly text: string;
  readonly did?: string | undefined;
}

/** `text` cut around every "@Name" of someone in `named`, the longest name first so "@Ann Lee" beats "@Ann" */
function splitMentions(text: string, named: ReadonlyArray<Someone>): Segment[] {
  const byName = new Map(named.map(({ did, name }) => [name.toLowerCase(), did]));
  if (!byName.size) return [{ text }];
  const names = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const at = new RegExp(`(^|\\s)@(${names.join('|')})(?=$|[\\s.,!?:;)])`, 'gi');
  const segments: Segment[] = [];
  let from = 0;
  for (const match of text.matchAll(at)) {
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    if (start > from) segments.push({ text: text.slice(from, start) });
    segments.push({ text: text.slice(start, end), did: byName.get((match[2] ?? '').toLowerCase()) });
    from = end;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}

/** Whom a text mentions, each once, never the person writing: what goes in a body's `mentions` */
export function mentionsIn(text: string, people: ReadonlyArray<Someone>): string[] {
  const others = people.filter((one) => one.did !== minca.me.did);
  return [...new Set(splitMentions(text, others).flatMap((segment) => (segment.did ? [segment.did] : [])))];
}

/** A text with its "@Name"s marked */
export function MentionText({ text }: { text: string }) {
  const people = usePeople();
  return html`${splitMentions(text, people).map((segment) =>
    segment.did ? html`<span class="mention">${segment.text}</span>` : segment.text,
  )}`;
}

/**
 * A one-line box where "@" suggests the space's people, above it as you
 * type; arrows move through them, Enter or Tab picks one. Anything else an
 * input takes (a paste handler, say) is passed on to the input.
 */
export function MentionInput({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
} & Omit<JSX.HTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const others = usePeople().filter((one) => one.did !== minca.me.did);
  const [caret, setCaret] = useState(0);
  const [choice, setChoice] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  const query = typed ? (typed[1] ?? '').toLowerCase() : null;
  const suggestions =
    query === null ? [] : others.filter((one) => one.name.toLowerCase().includes(query)).slice(0, 6);
  const pick = (someone: Someone) => {
    const before = value.slice(0, caret).replace(/@[^\s@]*$/, `@${someone.name} `);
    onChange(before + value.slice(caret));
    setCaret(before.length);
    setChoice(0);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(before.length, before.length);
    });
  };
  const caretOf = (event: Event) =>
    event.currentTarget instanceof HTMLInputElement ? (event.currentTarget.selectionStart ?? 0) : 0;

  return html`<div class="mention-input">
    ${
      suggestions.length > 0 &&
      html`<ul class="suggestions above" role="listbox">
        ${suggestions.map(
          (one, i) =>
            html`<li
              key=${one.did}
              role="option"
              aria-selected=${i === choice}
              onMouseDown=${(event: Event) => (event.preventDefault(), pick(one))}
            >
              <span class="row"><${Avatar} did=${one.did} size=${18} round /> ${one.name}</span>
            </li>`,
        )}
      </ul>`
    }
    <input
      ...${rest}
      ref=${input}
      value=${value}
      onInput=${(event: Event) => {
        if (!(event.currentTarget instanceof HTMLInputElement)) return;
        onChange(event.currentTarget.value);
        setCaret(caretOf(event));
        setChoice(0);
      }}
      onKeyUp=${(event: Event) => setCaret(caretOf(event))}
      onKeyDown=${(event: KeyboardEvent) => {
        if (!suggestions.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setChoice((choice + step + suggestions.length) % suggestions.length);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const someone = suggestions[choice] ?? suggestions[0];
          if (someone) pick(someone);
        } else if (event.key === 'Escape') setCaret(0);
      }}
    />
  </div>`;
}
