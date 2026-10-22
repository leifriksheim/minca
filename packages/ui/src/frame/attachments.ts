/**
 * `std.attachment` on a record: files kept in the space (`minca.addFile`) and
 * an attachment record about the record for each. Pictures show; other files
 * are saved to the person's device. A screen whose app names
 * `std.attachment` among its collections can use it.
 */
import { sizeOf } from '../size';
import { useFile, useRecords } from './hooks';
import { html } from './html';
import type { ScreenRecord } from './minca';

const ATTACHMENT = 'std.attachment';

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

/** Adds files to a record, each kept in the space with an attachment about the record */
export async function attach(about: string, files: Iterable<File>): Promise<void> {
  for (const file of files) {
    const mime = file.type || 'application/octet-stream';
    const blob = await minca.addFile(new Uint8Array(await file.arrayBuffer()), { name: file.name, mime });
    await minca.put(
      ATTACHMENT,
      { name: file.name, mime, size: file.size, blob },
      { links: [{ rel: 'about', to: about }] },
    );
  }
}

/** One attachment: the picture, or the file's name and size, saved when clicked */
function Attachment({ record }: { record: ScreenRecord<AttachmentBody> }) {
  const { name, mime, size, blob } = record.body;
  const picture = useFile(record.key, mime.startsWith('image/') ? blob : null);
  const save = () => void minca.download(record.key, blob.hash);
  if (picture)
    return html`<button type="button" class="attachment picture" title=${`Save ${name}`} onClick=${save}>
      <img src=${picture} alt=${name} />
    </button>`;
  return html`<button type="button" class="attachment" title="Save it" onClick=${save}>
    <span aria-hidden="true">📎</span>
    <span class="ellipsis">${name}</span>
    <span class="faint">${sizeOf(size)}</span>
  </button>`;
}

/** The files attached to a record */
export function Attachments({ about }: { about: string }) {
  const attachments = useRecords<AttachmentBody>(ATTACHMENT, { 'link:about': about });
  if (!attachments?.length) return null;
  return html`<div class="attachments">
    ${attachments.map((record) => html`<${Attachment} key=${record.key} record=${record} />`)}
  </div>`;
}
