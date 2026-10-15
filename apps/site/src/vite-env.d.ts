/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the app is, which "Open Minca" opens, e.g. http://localhost:5173 */
  readonly VITE_MINCA_APP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
