/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`minca run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_MINCA_NODES?: string;
  /** The host this build offers and restores accounts from (`minca host`), e.g. https://host.example */
  readonly VITE_MINCA_HOST?: string;
  /** Where new accounts claim usernames, e.g. minca.social: names are `<name>@<this>` */
  readonly VITE_NAMES_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
