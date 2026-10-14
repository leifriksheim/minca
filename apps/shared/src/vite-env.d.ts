/// <reference types="vite/client" />

/** What `relay.ts` reads; each app declares the rest of its own. */
interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`minca run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_MINCA_NODES?: string;
  /** The host this build offers and restores accounts from (`minca host`), e.g. https://host.example */
  readonly VITE_MINCA_HOST?: string;
  /** What "Connect an agent" and "Add a bot" tell people to run, e.g. `npm run minca -- connect` in this repo */
  readonly VITE_MINCA_CONNECT?: string;
  /** A Photon server for finding places (`places.ts`); photon.komoot.io when unset */
  readonly VITE_MINCA_PLACES?: string;
}
