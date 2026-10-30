/**
 * Any record, drawn the same way in every tool: a line that says what it is,
 * from what the standard collection holds, and opens it where it belongs
 * when clicked (`minca.open`). For a screen showing records of a collection
 * another tool owns, like a message's shared poll or the files of a task.
 */
import type { ComponentChildren } from 'preact';
import { sizeOf } from '../size';
import { shortWhen } from '../when';
import { useFile } from './hooks';
import { html } from './html';
import type { ScreenRecord } from './minca';
import { Avatar } from './people';

type Body = { readonly [field: string]: unknown };

const textOf = (body: Body, ...fields: string[]) => {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

/** A file's picture, or the mark for its kind */
function FileFace({ record }: { record: ScreenRecord }) {
  const { mime, blob } = record.body;
  const ref =
    typeof blob === 'object' && blob !== null && 'hash' in blob ? { hash: String(blob.hash) } : null;
  const picture = useFile(record.key, typeof mime === 'string' && mime.startsWith('image/') ? ref : null);
  if (picture) return html`<img class="record-face" src=${picture} alt="" />`;
  const kind = typeof mime === 'string' ? mime.split('/')[0] : '';
  return html`<span class="record-face" aria-hidden="true"
    >${kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄'}</span
  >`;
}

/** What a record of a standard collection is, in a few words, and a face for it */
function partsOf(record: ScreenRecord): { face: ComponentChildren; title: string; detail: string | null } {
  const body: Body = record.body;
  const by = record.createdBy ? html`<${Avatar} did=${record.createdBy} size=${20} round />` : null;
  switch (record.collection) {
    case 'std.file':
      return {
        face: html`<${FileFace} record=${record} />`,
        title: textOf(body, 'name') ?? 'A file',
        detail: typeof body.size === 'number' ? sizeOf(body.size) : null,
      };
    case 'std.message':
    case 'std.comment':
    case 'std.post':
      return { face: by, title: textOf(body, 'text') ?? '', detail: null };
    case 'std.task': {
      const done = body.status === 'done';
      return {
        face: html`<span aria-hidden="true">${done ? '☑' : '☐'}</span>`,
        title: textOf(body, 'title') ?? 'A task',
        detail: typeof body.due === 'string' ? `Due ${shortWhen({ start: body.due })}` : null,
      };
    }
    case 'std.event':
      return {
        face: html`<span aria-hidden="true">📅</span>`,
        title: textOf(body, 'title') ?? 'An event',
        detail: typeof body.start === 'string' ? shortWhen({ start: body.start }) : null,
      };
    case 'std.poll':
      return {
        face: html`<span aria-hidden="true">📊</span>`,
        title: textOf(body, 'question') ?? 'A poll',
        detail: null,
      };
    case 'std.list':
      return {
        face: html`<span aria-hidden="true">🗂</span>`,
        title: textOf(body, 'title') ?? 'A list',
        detail: null,
      };
    default:
      return {
        face: by,
        title: textOf(body, 'title', 'name', 'question', 'label', 'text') ?? record.collection,
        detail: null,
      };
  }
}

/** What a record is, in a few words: for a chip, or a message that shares it and says nothing else */
export const recordTitle = (record: ScreenRecord): string =>
  partsOf(record).title.trim().slice(0, 200) || 'Something';

/**
 * One record as a line: its face, what it is, and a click that opens it in
 * the tool it belongs to. A record shared from elsewhere opens through the
 * record that links to it, so `onOpen` says how.
 */
export function Record({ record, onOpen }: { record: ScreenRecord; onOpen?: () => void }) {
  const { face, title, detail } = partsOf(record);
  return html`<button
    type="button"
    class="record"
    title=${title}
    onClick=${() => (onOpen ? onOpen() : void minca.open({ record: record.key }))}
  >
    ${face}
    <span class="ellipsis">${title}</span>
    ${detail && html`<span class="faint">${detail}</span>`}
  </button>`;
}
