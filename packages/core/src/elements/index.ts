/**
 * @module elements
 * Web components for Minca, usable from any framework or none. Importing this
 * registers them.
 *
 * - `<minca-auth>` — the sign-in flow: where the data lives, which account,
 *   the ways into it. Fires `minca-session` when someone signs in or out.
 */
export { MincaAuthElement, defineMincaAuth } from './minca-auth.js';
export type { MincaSessionEventDetail } from './minca-auth.js';
export { createMincaAuth } from '../session/auth.js';
export type { MincaAuth, MincaAuthConfig, AuthState, MincaSession } from '../session/auth.js';
