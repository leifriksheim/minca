/**
 * A node's stores in a directory: a folder on this device, or a data folder
 * several apps and devices share (spec 05 §14). Takes any handle shaped like
 * the File System Access API's, so it runs in a browser and, through a
 * wrapper over `fs`, in Node.
 */
export { createFolderAdapter, decodeKey, readFolderFile, writeFolderFile } from './adapter.js';
export type { FolderAdapter, DirectoryHandleLike, FileHandleLike, WritableFileLike } from './adapter.js';
export { directoryStores, folderStores } from './stores.js';
export { createDirectoryBlobStore } from './blob-store.js';
export {
  isFolderStorageAvailable,
  pickDataFolder,
  queryFolderPermission,
  ensureFolderPermission,
  rememberDataFolder,
  recallDataFolder,
  forgetDataFolder,
} from './directory-access.js';
export type { FolderAccessMode } from './directory-access.js';
