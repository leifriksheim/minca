/**
 * @module auth
 * Signing in and staying signed in, with no framework: the flow as state and
 * actions (`createMincaAuth`). What an account home is built on.
 *
 * Browser-only: it reaches for IndexedDB, WebAuthn and the File System Access
 * API when used.
 */
export { createMincaAuth, connectionKey } from './auth.js';
export type {
  MincaAuth,
  MincaAuthConfig,
  UsernameClaim,
  AuthState,
  AuthStage,
  AuthSetup,
  AuthError,
  AccountEntry,
  MincaSession,
  MovedToPod,
  Connection,
  RetiredKey,
  GrantChoice,
  ProposeChoice,
} from './auth.js';
export { passwordStrength } from './password-strength.js';
export type { PasswordCheck, PasswordStrength } from './password-strength.js';
export { offerToSave, accountCredentialName, recoveryKit } from './credentials.js';
