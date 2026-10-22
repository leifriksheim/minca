/**
 * Files on a record: each kept in the space (`minca.addFile`) with a
 * `std.file` record about the record. Pictures show, and open
 * larger when clicked; videos and sound play where they are; other files are
 * saved to the person's device. A screen whose app names `std.file`
 * among its collections can use it.
 */
import { fitImage } from '../image';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { sizeOf } from '../size';
import { useBlob, useFile, useRecords } from './hooks';
import { html } from './html';
import { Modal } from './modal';
import type { ScreenRecord } from './minca';

const FILE = 'std.file';

/** A file a record refers to, as `minca.addFile` gives it */
interface FileRef {
  readonly hash: string;
  readonly size: number;
  readonly mime: string;
}

interface AttachmentBody {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: FileRef;
}

/**
 * Adds files to a record, each kept in the space with a `std.file` about the
 * record, or about nothing when `about` is null; large pictures made smaller.
 * Gives the files written.
 */
export async function attach(about: string | null, files: Iterable<File>): Promise<ScreenRecord[]> {
  const written: ScreenRecord[] = [];
  for (const file of await Promise.all([...files].map(fitImage))) {
    const mime = file.type || 'application/octet-stream';
    const blob = await minca.addFile(new Uint8Array(await file.arrayBuffer()), { name: file.name, mime });
    written.push(
      await minca.put(
        FILE,
        { name: file.name, mime, size: file.size, blob },
        about ? { links: [{ rel: 'about', to: about }] } : {},
      ),
    );
  }
  return written;
}

/** Whether an element has come into view; it stays true once it has, so what it loaded is kept */
export function useSeen(element: RefObject<Element>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (seen || !target) return;
    if (typeof IntersectionObserver !== 'function') return setSeen(true);
    const watch = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSeen(true),
      {
        rootMargin: '200px',
      },
    );
    watch.observe(target);
    return () => watch.disconnect();
  }, [seen, element]);
  return seen;
}

/**
 * A video or a sound that plays where it is: its whole file is fetched once it
 * comes into view, so a video shows its first frame without every one in a
 * long chat being fetched at once.
 */
export function Playable({ record }: { record: ScreenRecord<AttachmentBody> }) {
  const { name, mime, size, blob } = record.body;
  const box = useRef<HTMLDivElement>(null);
  const url = useBlob(record.key, useSeen(box) ? blob : null);
  const video = mime.startsWith('video/');
  return html`<div
    ref=${box}
    class=${video ? 'attachment playable video' : 'attachment playable'}
    title=${name}
  >
    ${
      !url
        ? html`<span class="faint">${video ? '▶' : '♪'} ${name} · ${sizeOf(size)}</span>`
        : video
          ? // #t: the first frame shows before it plays, in Safari too.
            html`<video
              src=${`${url}#t=0.1`}
              controls
              playsinline
              preload="metadata"
              aria-label=${name}
            ></video>`
          : html`<audio src=${url} controls preload="metadata" aria-label=${name}></audio>`
    }
  </div>`;
}

/** One attachment: the picture, opened larger when clicked, or the file's name and size, saved when clicked */
function Attachment({ record }: { record: ScreenRecord<AttachmentBody> }) {
  const { name, mime, size, blob } = record.body;
  const picture = useFile(record.key, mime.startsWith('image/') ? blob : null);
  const [open, setOpen] = useState(false);
  // Opened, the whole picture, not the one made smaller to show in the list
  const whole = useBlob(record.key, open ? blob : null);
  const save = () => void minca.download(record.key, blob.hash);
  if (blob && /^(video|audio)\//.test(mime)) return html`<${Playable} record=${record} />`;
  if (picture)
    return html`<button type="button" class="attachment picture" title=${name} onClick=${() => setOpen(true)}>
        <img src=${picture} alt=${name} />
      </button>
      ${
        open &&
        html`<${Modal} title=${name} width=${960} onClose=${() => setOpen(false)}>
          <img class="lightbox" src=${whole ?? picture} alt=${name} />
          <div class="row" style="justify-content: flex-end">
            <span class="faint" style="flex: 1">${sizeOf(size)}</span>
            <button type="button" onClick=${save}>Download</button>
          </div>
        <//>`
      }`;
  return html`<button type="button" class="attachment" title="Save it" onClick=${save}>
    <span aria-hidden="true">📎</span>
    <span class="ellipsis">${name}</span>
    <span class="faint">${sizeOf(size)}</span>
  </button>`;
}

/** The files attached to a record */
export function Attachments({ about }: { about: string }) {
  const attachments = useRecords<AttachmentBody>(FILE, { 'link:about': about });
  if (!attachments?.length) return null;
  return html`<div class="attachments">
    ${attachments.map((record) => html`<${Attachment} key=${record.key} record=${record} />`)}
  </div>`;
}
