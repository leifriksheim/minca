/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the app is, which "Open Minca" opens, e.g. http://localhost:5173 */
  readonly VITE_MINCA_APP?: string;
  /** Minca's MCP service chat apps connect to (`@minca/app-shared/mcp`), e.g. http://localhost:8791/mcp */
  readonly VITE_MINCA_MCP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
