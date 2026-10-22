/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes, comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_MINCA_NODES?: string;
  /** Where a new device looks for its account, e.g. https://host.example */
  readonly VITE_MINCA_HOST?: string;
  /** The account home's connect page, e.g. http://localhost:5174/connect */
  readonly VITE_MINCA_HOME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
