/**
 * Files on a record: each kept in the space (`minca.addFile`) with a
 * `std.file` record about the record. Pictures show as their thumbnail, and
 * open whole when clicked; videos show theirs, and play where they are when
 * clicked; other files are saved to the person's device. A screen asks for
 * a file itself only when it is opened or played. A screen whose app names
 * `std.file` among its collections can use it.
 */
import { fitImage, showsThumbnail, thumbnailOf } from '../image';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { sizeOf } from '../size';
import { useBlob, useFile, useRecords } from './hooks';
import { html } from './html';
import { Modal } from './modal';
import type { ScreenRecord } from './minca';
import { Icon } from './shapes';

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
  readonly thumbnail?: FileRef;
}

/** A File kept in the space, as `minca.addFile` gives it */
const keep = async (file: File, mime: string) =>
  minca.addFile(new Uint8Array(await file.arrayBuffer()), { name: file.name, mime });

/**
 * Adds files to a record, each kept in the space with a `std.file` about the
 * record, or about nothing when `about` is null; large pictures made smaller,
 * and pictures and videos given a thumbnail. Gives the files written.
 */
export async function attach(about: string | null, files: Iterable<File>): Promise<ScreenRecord[]> {
  const written: ScreenRecord[] = [];
  for (const file of await Promise.all([...files].map(fitImage))) {
    const mime = file.type || 'application/octet-stream';
    const blob = await keep(file, mime);
    const still = await thumbnailOf(file);
    const thumbnail = still ? await keep(still, still.type) : null;
    written.push(
      await minca.put(
        FILE,
        { name: file.name, mime, size: file.size, blob, ...(thumbnail ? { thumbnail } : {}) },
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
 * A video or a sound that plays where it is. Its thumbnail shows until it is
 * clicked; only then is the whole file fetched, so scrolling past videos
 * costs nothing but their stills.
 */
export function Playable({ record }: { record: ScreenRecord<AttachmentBody> }) {
  const { name, mime, size, blob, thumbnail } = record.body;
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const url = useBlob(record.key, playing ? blob : null);
  const still = useFile(record.key, useSeen(box) && showsThumbnail(mime, thumbnail) ? thumbnail : null);
  const video = mime.startsWith('video/');
  return html`<div
    ref=${box}
    class=${video ? 'attachment playable video' : 'attachment playable'}
    title=${name}
  >
    ${
      !url
        ? html`<button type="button" class="play" disabled=${playing} onClick=${() => setPlaying(true)}>
            ${still && html`<img src=${still} alt="" />`}
            <small>${playing ? 'Loading…' : `${video ? '▶' : '♪'} ${name} · ${sizeOf(size)}`}</small>
          </button>`
        : video
          ? html`<video
              src=${url}
              controls
              autoplay
              playsinline
              poster=${still ?? undefined}
              aria-label=${name}
            ></video>`
          : html`<audio src=${url} controls autoplay aria-label=${name}></audio>`
    }
  </div>`;
}

/** One attachment: the picture, opened larger when clicked, or the file's name and size, saved when clicked */
function Attachment({ record }: { record: ScreenRecord<AttachmentBody> }) {
  const { name, mime, size, blob, thumbnail } = record.body;
  // A GIF shows whole, since the smaller one made to show in the list is a still of its first frame.
  const moving = mime === 'image/gif';
  // Its thumbnail when it has one; the picture itself only in older records, which have none.
  const shown = showsThumbnail(mime, thumbnail) ? thumbnail : blob;
  const still = useFile(record.key, mime.startsWith('image/') && !moving ? shown : null);
  const [open, setOpen] = useState(false);
  // Opened, the whole picture, not the one made smaller to show in the list
  const whole = useBlob(record.key, open || moving ? blob : null);
  const picture = moving ? whole : still;
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
          <div class="row" data-spread>
            <small>${sizeOf(size)}</small>
            <button type="button" onClick=${save}>Download</button>
          </div>
        <//>`
      }`;
  return html`<button type="button" class="attachment" title="Save it" onClick=${save}>
    <${Icon} name="attach" size=${16} />
    <span class="truncate">${name}</span>
    <small>${sizeOf(size)}</small>
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
