/**
 * Files in the app: a picture or attachment's bytes as a URL the page can
 * show, a picture made small before it is added, and a file saved to disk.
 * The bytes come from `records.readFile` (spec 05 §16.6).
 */
import { useEffect, useState } from 'react';
import { useNode } from '@minca/core/react';
import type { FileRef } from '@minca/core';

/** Object URLs by file id: one per file for the life of the page, however many places show it */
const urls = new Map<string, Promise<string>>();

/** A URL for a file a body refers to, once its bytes are here; null until then, or if none can be had */
export function useFileUrl(spaceId: string, ref: FileRef | null | undefined): string | null {
  const node = useNode();
  const [url, setUrl] = useState<string | null>(null);
  const hash = ref?.hash ?? null;
  useEffect(() => {
    if (!ref || !hash) return setUrl(null);
    let live = true;
    let made = urls.get(hash);
    if (!made) {
      made = node.records
        .readFile(spaceId, ref)
        .then((bytes) => URL.createObjectURL(new Blob([bytes.slice()], { type: ref.mime })));
      // A file that couldn't be had now may be had later: not remembered.
      made.catch(() => urls.delete(hash));
      urls.set(hash, made);
    }
    made.then(
      (made) => live && setUrl(made),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
    // The file is named by its id: a new object for the same file is the same file.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the file's id
  }, [node, spaceId, hash]);
  return url;
}

/** An image made at most `side` pixels on its longer side, as WebP: what a picture is added as */
export async function shrinkImage(file: Blob, side = 512): Promise<{ bytes: Uint8Array; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/webp' };
}

/** Saves a file's bytes to disk under its name */
export function saveFile(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A size people read: 812 KB, 3.1 MB */
export function sizeOf(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
