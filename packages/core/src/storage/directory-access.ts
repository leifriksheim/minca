/**
 * Getting hold of the user's data folder, and getting it back on the next visit.
 *
 * A directory handle comes only from a user gesture, and its permission must
 * be confirmed again each session. The handle itself can be kept in IndexedDB.
 */

import type { DirectoryHandleLike } from './folder-adapter.js';
import { protocolError } from '../utils/errors.js';
import { isObject } from '../utils/guards.js';
import { idbOnce } from '../identity/idb.js';

/** Read or read-write, in the browser's vocabulary */
export type FolderAccessMode = 'read' | 'readwrite';

/** The permission methods the spec puts on a handle but `lib.dom` does not */
interface PermissionAwareHandle {
  queryPermission(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: FolderAccessMode }): Promise<PermissionState>;
}

/** The picker the spec puts on the window but `lib.dom` does not */
interface DirectoryPicker {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<DirectoryHandleLike>;
}

interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: FolderAccessMode;
  readonly startIn?: string;
}

const HANDLE_DB = 'minca-folder';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'data-folder';

function hasPicker(scope: object): scope is DirectoryPicker {
  return 'showDirectoryPicker' in scope && typeof scope.showDirectoryPicker === 'function';
}

function canQuery(handle: object): handle is Pick<PermissionAwareHandle, 'queryPermission'> {
  return 'queryPermission' in handle && typeof handle.queryPermission === 'function';
}

function canRequest(handle: object): handle is Pick<PermissionAwareHandle, 'requestPermission'> {
  return 'requestPermission' in handle && typeof handle.requestPermission === 'function';
}

function isDirectoryHandle(value: unknown): value is DirectoryHandleLike {
  return isObject(value) && typeof value.getDirectoryHandle === 'function';
}

/** Whether this browser can hand out a directory at all: only desktop Chrome, Edge and Opera can */
export function isFolderStorageAvailable(): boolean {
  return hasPicker(globalThis);
}

/**
 * Asks the user to choose their data folder. Must be called from a click.
 *
 * @param options.id Groups the picker's memory of where it last opened.
 */
export async function pickDataFolder(options?: { id?: string }): Promise<DirectoryHandleLike> {
  const scope: object = globalThis;
  if (!hasPicker(scope)) {
    throw protocolError(
      'FOLDER_UNAVAILABLE',
      'This browser cannot open a data folder.',
      'The File System Access API is available in Chrome, Edge and Opera on the ' +
        'desktop. Elsewhere, sign in with a recovery code and this device will ' +
        'keep its own copy that syncs with your peers.',
    );
  }

  return scope.showDirectoryPicker({
    id: options?.id ?? 'minca-pod',
    mode: 'readwrite',
    startIn: 'documents',
  });
}

/** Asks what this origin is currently allowed to do with a folder. */
export async function queryFolderPermission(
  handle: DirectoryHandleLike,
  mode: FolderAccessMode = 'readwrite',
): Promise<PermissionState> {
  // A handle from a runtime without permissions
  if (!canQuery(handle)) return 'granted';
  return handle.queryPermission({ mode });
}

/**
 * Makes sure this origin may use a folder, prompting if `request` is true.
 * The prompt needs a user gesture, so only pass it on a path that began with a click.
 */
export async function ensureFolderPermission(
  handle: DirectoryHandleLike,
  options?: { request?: boolean; mode?: FolderAccessMode },
): Promise<boolean> {
  const mode = options?.mode ?? 'readwrite';
  if ((await queryFolderPermission(handle, mode)) === 'granted') return true;
  if (!options?.request || !canRequest(handle)) return false;
  return (await handle.requestPermission({ mode })) === 'granted';
}

/** Remembers a folder's handle, so the next visit can skip the picker */
export async function rememberDataFolder(handle: DirectoryHandleLike): Promise<void> {
  await idbOnce(HANDLE_DB, HANDLE_STORE, 'readwrite', (store) => store.put(handle, HANDLE_KEY));
}

/** The folder this origin used last, if the browser still has it; it may still need {@link ensureFolderPermission} */
export async function recallDataFolder(): Promise<DirectoryHandleLike | null> {
  try {
    const value = await idbOnce(HANDLE_DB, HANDLE_STORE, 'readonly', (store) => store.get(HANDLE_KEY));
    return isDirectoryHandle(value) ? value : null;
  } catch {
    return null;
  }
}

/** Forgets the remembered folder. The folder and everything in it stay put. */
export async function forgetDataFolder(): Promise<void> {
  try {
    await idbOnce(HANDLE_DB, HANDLE_STORE, 'readwrite', (store) => store.delete(HANDLE_KEY));
  } catch {
    // Nothing to forget.
  }
}
