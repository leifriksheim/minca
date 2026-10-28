import { useRef, useState } from 'react';
import { useNode } from '@minca/react';
import type { FileRef, NodeRecord, SpaceSummary } from '@minca/core';
import { file as fileCollection } from '@minca/core/schemas';
import { bodyOf } from '../../derive/schema-ui';
import { fileRefOf } from '../../derive/kinds';
import { fitImage } from '@minca/ui/image';
import { sizeOf } from '@minca/ui/size';
import { saveFile, useFileUrl } from '../../files';
import { palette, styles } from '../../styles';

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
  compact = false,
}: {
  space: SpaceSummary;
  target: string;
  attachments: ReadonlyArray<NodeRecord>;
  /** Only the files, no title or button: under a chat message, say */
  compact?: boolean;
}) {
  const node = useNode();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sorted = [...attachments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      await attachFiles(node, space.id, target, files);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section aria-label="Attachments" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!compact && (
        <h3 style={styles.sectionTitle}>
          Attachments{' '}
          {attachments.length > 0 && (
            <span style={{ color: palette.ink.faint, fontWeight: 400 }}>{attachments.length}</span>
          )}
        </h3>
      )}
      {sorted.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {sorted.map((record) => (
            <AttachmentView key={record.key} space={space} record={record} />
          ))}
        </div>
      )}
      {!compact && space.writable && (
        <div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => void attach(event.target.files)}
          />
          <button
            onClick={() => input.current?.click()}
            disabled={busy}
            data-variant="quiet"
            style={styles.smallButton}
          >
            {busy ? 'Attaching…' : 'Attach files'}
          </button>
        </div>
      )}
      {error && <p style={{ margin: 0, fontSize: 13, color: palette.ink.muted }}>{error}</p>}
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
        onClick={() => void save()}
        title={`${name} — click to save`}
        style={{ ...tile, width: 160, height: 120, padding: 0, overflow: 'hidden' }}
      >
        {url ? (
          <img src={url} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 12, color: palette.ink.faint }}>Loading…</span>
        )}
      </button>
    );
  return (
    <button
      onClick={() => void save()}
      disabled={!file || saving}
      title={file ? 'Save' : 'This file is kept elsewhere'}
      style={{ ...tile, padding: '8px 12px', gap: 2, alignItems: 'flex-start', flexDirection: 'column' }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, color: palette.ink.strong }}>{name}</span>
      <span style={{ fontSize: 12, color: palette.ink.faint }}>
        {saving ? 'Fetching…' : file ? sizeOf(Number(body.size ?? file.size)) : 'No bytes here'}
      </span>
    </button>
  );
}

const tile = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: palette.radius.md,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
  maxWidth: 260,
} as const;
