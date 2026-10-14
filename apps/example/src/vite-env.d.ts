/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`minca run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_MINCA_NODES?: string;
  /** The host this build offers and restores accounts from (`minca host`), e.g. https://host.example */
  readonly VITE_MINCA_HOST?: string;
  /** The account home's connect page, e.g. http://localhost:5174/connect */
  readonly VITE_MINCA_HOME?: string;
  /** What "Connect an agent" tells people to run, before the code. Default `npx @minca/cli connect` */
  readonly VITE_MINCA_CONNECT?: string;
  /** A Photon server for finding places (`@minca/app-shared/places`); photon.komoot.io when unset */
  readonly VITE_MINCA_PLACES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Document Picture-in-Picture (Chrome, Edge), not yet in TypeScript's DOM types */
interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
declare var documentPictureInPicture: DocumentPictureInPicture | undefined;
