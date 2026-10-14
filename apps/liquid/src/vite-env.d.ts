/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`minca run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_MINCA_NODES?: string;
  /** The host this build offers and restores accounts from (`minca host`), e.g. https://host.example */
  readonly VITE_MINCA_HOST?: string;
  /** What "Add a bot" tells an admin to run, e.g. `npm run minca -- connect` in this repo */
  readonly VITE_MINCA_CONNECT?: string;
  /** The account home's connect page, e.g. http://localhost:5174/connect */
  readonly VITE_MINCA_HOME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
