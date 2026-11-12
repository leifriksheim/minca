/**
 * What the playground uses of Minca, in one place. Core's source imports
 * `./x.js` for `./x.ts`, which Turbopack can't follow, so scripts/sync.mjs
 * bundles this file with esbuild into .minca/playground.js, and
 * next.config.mjs points `@minca/playground` at that. TypeScript reads this
 * file instead (tsconfig.json), so the types are the source's.
 */
export { createMincaConnection, type MincaConnection } from '@minca/core/session';
// useSchemas defines what a space lacks; it isn't a React hook, whatever its name says.
export { listItem, useSchemas as addSchemas } from '@minca/std';
export type { NodeCollection } from '@minca/core';
export { MincaProvider, useAccount, useConnection, useNode, useQuery, useSpaces } from '@minca/react';
export { createScreenBridge, screenDocument } from '@minca/app-shared/screens';
