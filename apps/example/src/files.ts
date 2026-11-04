/**
 * Files in the app: a picture or attachment's bytes as a URL the page can
 * show, a picture made small before it is added, and a file saved to disk.
 * The bytes come from `records.readFile` (spec 05 §16.6).
 */
import { useAsync, useNode } from '@minca/react';
import type { FileRef, P2PNode } from '@minca/core';

/** Object URLs by file id: one per file for the life of the page, however many places show it */
const urls = new Map<string, Promise<string>>();

function objectUrl(node: P2PNode, spaceId: string, ref: FileRef): Promise<string> {
  const cached = urls.get(ref.hash);
  if (cached) return cached;
  const made = node.records
    .readFile(spaceId, ref)
    .then((bytes) => URL.createObjectURL(new Blob([bytes.slice()], { type: ref.mime })));
  // A file that couldn't be had now may be had later: not remembered.
  made.catch(() => urls.delete(ref.hash));
  urls.set(ref.hash, made);
  return made;
}

/** A URL for a file a body refers to, once its bytes are here; null until then, or if none can be had */
export function useFileUrl(spaceId: string, ref: FileRef | null | undefined): string | null {
  const node = useNode();
  // Keyed by the file's id: a new object for the same file is the same file.
  const url = useAsync(
    async () => (ref?.hash ? objectUrl(node, spaceId, ref) : null),
    [node, spaceId, ref?.hash],
  );
  return url.status === 'done' ? url.value : null;
}

/** Saves a file's bytes to disk under its name */
export function saveFile(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
