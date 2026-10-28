/**
 * Values shown by what their field holds (`x-kind`): a person by name, a
 * time in the reader's words, money in their format, a link, a file.
 */
import type { ReactNode } from 'react';
import { useNode } from '@minca/react';
import type { FileRef } from '@minca/core';
import { sizeOf } from '@minca/ui/size';
import { fileRefOf, moneyText, safeHref, whenText } from '../derive/kinds';
import { isObject } from '../derive/schema-ui';
import { saveFile, useFileUrl } from '../files';
import { Person, useSpaceHere } from './Person';
import { palette, styles } from '../styles';

/** A value as its kind says to show it, or null to show it plainly */
export function byKind(kind: string, value: unknown, compact: boolean): ReactNode | null {
  switch (kind) {
    case 'did':
      return typeof value === 'string' ? <Person did={value} /> : null;
    case 'when':
    case 'day': {
      const text = whenText(value);
      return text ? <span>{text}</span> : null;
    }
    case 'url': {
      const href = safeHref(value);
      if (!href) return null;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          // Opening the link isn't editing the field it sits in.
          onClick={(e) => e.stopPropagation()}
          style={{ wordBreak: 'break-all' }}
        >
          {compact ? new URL(href).host : href}
        </a>
      );
    }
    case 'money': {
      const text = moneyText(value);
      return text ? <span>{text}</span> : null;
    }
    case 'file': {
      const ref = fileRefOf(value);
      return ref ? <FileValue value={ref} compact={compact} /> : null;
    }
    case 'image': {
      const ref = isObject(value) ? fileRefOf(value.blob) : null;
      const alt = isObject(value) && typeof value.alt === 'string' ? value.alt : '';
      return ref ? <FileValue value={ref} alt={alt} compact={compact} /> : null;
    }
    default:
      return null;
  }
}

/** People, by name */
export function PeopleValue({ value }: { value: ReadonlyArray<unknown> }) {
  return (
    <span>
      {value
        .filter((did): did is string => typeof did === 'string')
        .map((did, i) => (
          <span key={did}>
            {i > 0 && ', '}
            <Person did={did} />
          </span>
        ))}
    </span>
  );
}

/** A file: a picture shown, anything else by its name and size, to save */
export function FileValue({
  value,
  alt = '',
  compact = false,
}: {
  value: FileRef;
  alt?: string;
  compact?: boolean;
}) {
  const node = useNode();
  const space = useSpaceHere();
  const isPicture = value.mime.startsWith('image/');
  const url = useFileUrl(space?.id ?? '', space && isPicture ? value : null);
  const name = value.name ?? (isPicture ? 'Picture' : 'File');
  if (url)
    return (
      <img
        src={url}
        alt={alt}
        title={alt || name}
        style={{
          display: 'block',
          maxWidth: compact ? 32 : 240,
          maxHeight: compact ? 32 : 240,
          borderRadius: palette.radius.md,
          objectFit: 'cover',
        }}
      />
    );
  const save = async () => {
    if (space) saveFile(await node.records.readFile(space.id, value), name, value.mime);
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
      <span>{name}</span>
      <span style={{ color: palette.ink.muted, fontSize: 12 }}>{sizeOf(value.size)}</span>
      {!compact && space && (
        <button type="button" data-variant="ghost" style={styles.linkButton} onClick={() => void save()}>
          Save
        </button>
      )}
    </span>
  );
}
