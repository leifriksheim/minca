/**
 * "@" mentions, the way the app has them: a sent text names whom it mentions
 * (a body's `mentions`, so they can be told). The box suggests people as "@" is
 * typed (editor.ts) and a shown text marks them (markdown.ts).
 */
import type { Someone } from './minca';

/** A run of text, and whom it mentions when it is an "@Name" */
interface Segment {
  readonly text: string;
  readonly did?: string | undefined;
}

/** `text` cut around every "@Name" of someone in `named`, the longest name first so "@Ann Lee" beats "@Ann" */
export function splitMentions(text: string, named: ReadonlyArray<Someone>): Segment[] {
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
