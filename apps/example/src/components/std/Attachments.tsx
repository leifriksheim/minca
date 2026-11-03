import { useRef, useState } from 'react';
import { useNode } from '@minca/react';
import type { FileRef, NodeRecord, SpaceSummary } from '@minca/core';
import { file as fileCollection } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { fileRefOf } from '../../derive/kinds';
import { fitImage } from '@minca/ui/image';
import { sizeOf } from '@minca/ui/size';
import { saveFile, useFileUrl } from '../../files';
import styles from './Attachments.module.css';
import { useAction } from '@minca/app-shared/action';

/** The file an attachment names, when its body holds one */
const fileOf = (record: NodeRecord): FileRef | null => fileRefOf(bodyOf(record).blob);

/** Adds files to a record as `std.file`s about it; large pictures made smaller */
async function attachFiles(
  node: ReturnType<typeof useNode>,
  spaceId: string,
  target: string,
  files: Iterable<File>,
): Promise<void> {
  for (const file of await Promise.all([...files].map(fitImage))) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || 'application/octet-stream';
    const blob = await node.records.addFile(spaceId, bytes, { mime, name: file.name });
    await node.records.put(
      spaceId,
      fileCollection.name,
      { name: file.name, mime, size: file.size, blob },
      { links: [{ rel: 'about', to: target }] },
    );
  }
}

/**
 * `std.file`s on a record: pictures shown, other files to save, and a
 * button to attach more. Any mini app showing a record can use it: the files
 * belong to the record, not to the app.
 */
export function Attachments({
  space,
  target,
  attachments,
}: {
  space: SpaceSummary;
  target: string;
  attachments: ReadonlyArray<NodeRecord>;
}) {
  const node = useNode();
  const input = useRef<HTMLInputElement>(null);
  const { run, busy, error } = useAction();
  const sorted = [...attachments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    await run(() => attachFiles(node, space.id, target, files));
    if (input.current) input.current.value = '';
  };

  return (
    <section aria-label="Attachments" data-gap="tight">
      <h3>Attachments {attachments.length > 0 && <small>{attachments.length}</small>}</h3>
      {sorted.length > 0 && (
        <div className="row">
          {sorted.map((record) => (
            <AttachmentView key={record.key} space={space} record={record} />
          ))}
        </div>
      )}
      {space.writable && (
        <div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => void attach(event.target.files)}
          />
          <button onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Attaching…' : 'Attach files'}
          </button>
        </div>
      )}
      {error && <small>{error}</small>}
    </section>
  );
}

/** One attachment: a picture as itself, any other file as its name and size, saved when clicked */
function AttachmentView({ space, record }: { space: SpaceSummary; record: NodeRecord }) {
  const node = useNode();
  const body = bodyOf(record);
  const file = fileOf(record);
  const name = typeof body.name === 'string' ? body.name : 'File';
  const picture = file?.mime.startsWith('image/') ?? false;
  const url = useFileUrl(space.id, picture ? file : null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!file) return;
    setSaving(true);
    try {
      saveFile(await node.records.readFile(space.id, file), name, file.mime);
    } finally {
      setSaving(false);
    }
  };

  if (picture)
    return (
      <button
        data-intent="open"
        onClick={() => void save()}
        title={`${name} — click to save`}
        className={styles.picture}
      >
        <figure>{url ? <img src={url} alt={name} /> : <small>Loading…</small>}</figure>
      </button>
    );
  return (
    <button
      data-intent="open"
      onClick={() => void save()}
      disabled={!file || saving}
      title={file ? 'Save' : 'This file is kept elsewhere'}
    >
      <strong>{name}</strong>
      <small>{saving ? 'Fetching…' : file ? sizeOf(Number(body.size ?? file.size)) : 'No bytes here'}</small>
    </button>
  );
}
