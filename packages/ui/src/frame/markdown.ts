/**
 * Markdown, as a message, comment or post is written: the parts of CommonMark a
 * chat uses, and GitHub's tables and strikethrough. Drawn as elements, never as
 * HTML, so a text can't put markup of its own on the screen.
 */
import type { ComponentChildren } from 'preact';
import { usePeople } from './hooks';
import { html } from './html';
import { splitMentions } from './mentions';
import type { Someone } from './minca';
import { LinkPreviews } from './previews';

/** A fence opens a code block only when nothing after it on the line is a backtick: ```hello``` is inline code */
const FENCE = /^\s{0,3}(`{3,}(?=[^`]*$)|~{3,})/;
/** A line drawn with box-drawing characters, like a table pasted from a terminal: kept as written, fenced or not */
const BOX = /[─-╿]/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)[\s#]*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

type Block =
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: string[] }
  | { readonly kind: 'table'; readonly head: string[]; readonly rows: string[][] }
  | { readonly kind: 'paragraph'; readonly text: string };

/** A table row's cells, without the pipes at its ends */
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

const isTable = (line: string, next = '') =>
  line.includes('|') && next.includes('-') && TABLE_RULE.test(next);

/** A text's blocks, line by line: a paragraph runs until a blank line or the start of another block */
function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const line = () => lines[i] ?? '';
  const starts = () =>
    FENCE.test(line()) ||
    BOX.test(line()) ||
    HEADING.test(line()) ||
    QUOTE.test(line()) ||
    ITEM.test(line()) ||
    RULE.test(line()) ||
    isTable(line(), lines[i + 1]);
  /** The lines from here on that `keep` takes */
  const take = (keep: (line: string) => boolean) => {
    const run: string[] = [];
    while (i < lines.length && keep(line())) run.push(lines[i++] ?? '');
    return run;
  };

  while (i < lines.length) {
    const fence = FENCE.exec(line());
    const item = ITEM.exec(line());
    if (!line().trim()) i++;
    else if (fence) {
      const close = fence[1] ?? '```';
      i++;
      const code = take((l) => !l.trimStart().startsWith(close));
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
    } else if (BOX.test(line())) blocks.push({ kind: 'code', text: take((l) => BOX.test(l)).join('\n') });
    else if (HEADING.test(line()))
      blocks.push({ kind: 'heading', text: HEADING.exec(lines[i++] ?? '')?.[1] ?? '' });
    else if (RULE.test(line())) {
      i++;
      blocks.push({ kind: 'rule' });
    } else if (QUOTE.test(line())) {
      const quoted = take((l) => QUOTE.test(l)).map((l) => QUOTE.exec(l)?.[1] ?? '');
      blocks.push({ kind: 'quote', text: quoted.join('\n') });
    } else if (item) {
      const ordered = /\d/.test(item[1] ?? '');
      const items: string[] = [];
      // Items of the one kind, and a line indented under one carries it on
      take((l) => {
        const next = ITEM.exec(l);
        if (next && /\d/.test(next[1] ?? '') === ordered) items.push(next[2] ?? '');
        else if (/^\s+\S/.test(l) && items.length) items.push(`${items.pop() ?? ''}\n${l.trim()}`);
        else return false;
        return true;
      });
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(item[1] ?? '1', 10) : 1, items });
    } else if (isTable(line(), lines[i + 1])) {
      const head = cellsOf(line());
      i += 2;
      // A row has the head's columns: cells past them go, as GitHub has it
      const rows = take((l) => l.includes('|')).map((l) => cellsOf(l).slice(0, head.length));
      blocks.push({ kind: 'table', head, rows });
    } else {
      const run = [lines[i++] ?? ''];
      while (i < lines.length && line().trim() && !starts()) run.push(lines[i++] ?? '');
      blocks.push({ kind: 'paragraph', text: run.join('\n') });
    }
  }
  return blocks;
}

/**
 * The marks inside a line, the first to start winning: `code` (or ``code``, as
 * many backticks closing it as opened it), **bold**,
 * __bold__, ~~struck~~, *emphasis*, _emphasis_, [a link](https://…) and a bare
 * https:// link. A mark hugs its words, so 2*3*4 and snake_case stay as written.
 */
const INLINE = new RegExp(
  [
    /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/.source,
    /\*\*(?=\S)(.+?)(?<=\S)\*\*/.source,
    /__(?=\S)(.+?)(?<=\S)__/.source,
    /~~(?=\S)(.+?)(?<=\S)~~/.source,
    /(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/.source,
    /(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/.source,
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.source,
    // A private-use character ends a link: the box that edits text stands it in for the caret
    /(https?:\/\/[^\s<>"'\ue000]+[^\s<>"'.,;:!?)\]}*_~\ue000])/.source,
  ].join('|'),
  'g',
);

/** A link as it shows: its site and path, without https:// or www., cut short when long */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    const shown = url.host.replace(/^www\./, '') + url.pathname.replace(/\/$/, '') + url.search + url.hash;
    return shown.length > 42 ? `${shown.slice(0, 40)}…` : shown;
  } catch {
    return link;
  }
}

/** A link that opens in a new tab, through the page: a screen can't open one itself */
const linkTo = (href: string, children: ComponentChildren) =>
  html`<a
    href=${href}
    title=${href}
    onClick=${(event: Event) => {
      event.preventDefault();
      void minca.link(href);
    }}
    >${children}</a
  >`;

/** Plain words: their "@Name"s marked, their line breaks kept */
const words = (text: string, people: ReadonlyArray<Someone>): ComponentChildren[] =>
  splitMentions(text, people).flatMap((segment) =>
    segment.did
      ? [html`<mark>${segment.text}</mark>`]
      : segment.text.split('\n').flatMap((part, i) => (i ? [html`<br />`, part] : [part])),
  );

/** A line's marks, drawn */
function inline(text: string, people: ReadonlyArray<Someone>): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let from = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > from) out.push(...words(text.slice(from, match.index), people));
    const [, , code, bold, bolder, struck, em, emphasis, label, href, url] = match;
    const strong = bold ?? bolder;
    const italic = em ?? emphasis;
    if (code !== undefined) out.push(html`<code>${code.trim()}</code>`);
    else if (strong !== undefined) out.push(html`<strong>${inline(strong, people)}</strong>`);
    else if (struck !== undefined) out.push(html`<s>${inline(struck, people)}</s>`);
    else if (italic !== undefined) out.push(html`<em>${inline(italic, people)}</em>`);
    else if (href !== undefined) out.push(linkTo(href, inline(label ?? href, people)));
    else if (url !== undefined) out.push(linkTo(url, shortLink(url)));
    from = match.index + match[0].length;
  }
  if (from < text.length) out.push(...words(text.slice(from), people));
  return out;
}

/** The links a text sends, in order, each once: not those in code or quoted from someone else */
function linksIn(blocks: ReadonlyArray<Block>): string[] {
  const found = new Set<string>();
  const visit = (line: string) => {
    for (const match of line.matchAll(INLINE)) {
      const [, , , bold, bolder, struck, em, emphasis, , href, url] = match;
      const marked = bold ?? bolder ?? struck ?? em ?? emphasis;
      const link = href ?? url;
      if (marked !== undefined) visit(marked);
      else if (link !== undefined) found.add(link);
    }
  };
  for (const block of blocks) {
    if (block.kind === 'heading' || block.kind === 'paragraph') visit(block.text);
    else if (block.kind === 'list') block.items.forEach(visit);
    else if (block.kind === 'table') [block.head, ...block.rows].flat().forEach(visit);
  }
  return [...found];
}

function drawBlock(block: Block, people: ReadonlyArray<Someone>, end: ComponentChildren): ComponentChildren {
  switch (block.kind) {
    case 'code':
      return html`<pre><code>${block.text}</code></pre>`;
    case 'heading':
      return html`<p><strong>${inline(block.text, people)}</strong>${end}</p>`;
    case 'rule':
      return html`<hr />`;
    case 'quote':
      return html`<blockquote>${blocksOf(block.text).map((b) => drawBlock(b, people, null))}</blockquote>`;
    case 'list': {
      const items = block.items.map((item) => html`<li>${inline(item, people)}</li>`);
      return block.ordered
        ? html`<ol start=${block.start}>
            ${items}
          </ol>`
        : html`<ul>
            ${items}
          </ul>`;
    }
    case 'table':
      return html`<table>
        <thead>
          <tr>
            ${block.head.map((cell) => html`<th>${inline(cell, people)}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${block.rows.map(
            (row) =>
              html`<tr>
                ${row.map((cell) => html`<td>${inline(cell, people)}</td>`)}
              </tr>`,
          )}
        </tbody>
      </table>`;
    case 'paragraph':
      return html`<p>${inline(block.text, people)}${end}</p>`;
  }
}

/**
 * A text as Markdown, with its "@Name"s marked. `end` goes at the end of its
 * last paragraph, like "(edited)" after a message. The links it sends get a
 * preview under it, as in a chat.
 */
export function MentionText({ text, end = null }: { text: string; end?: ComponentChildren }) {
  const people = usePeople();
  const blocks = blocksOf(text);
  const previews = html`<${LinkPreviews} links=${linksIn(blocks)} />`;
  // One paragraph stays in its line, so a screen can still put it inside a sentence of its own
  const only = blocks.length === 1 && blocks[0]?.kind === 'paragraph' ? blocks[0] : null;
  if (only) return html`<span class="markdown">${inline(only.text, people)}${end}${previews}</span>`;
  return html`<div class="markdown">${markdownOf(text, people, end)}${previews}</div>`;
}

/** The elements for a Markdown text, for the box that edits it too */
export function markdownOf(text: string, people: ReadonlyArray<Someone> = [], end: ComponentChildren = null) {
  const blocks = blocksOf(text);
  const last = blocks.at(-1);
  // After a paragraph, in its line; after anything else, under it
  const inLine = last?.kind === 'paragraph' || last?.kind === 'heading';
  const drawn = blocks.map((block) => drawBlock(block, people, inLine && block === last ? end : null));
  return inLine ? drawn : [...drawn, end];
}
