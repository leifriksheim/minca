/**
 * @module session
 * Signing in and staying signed in, with no framework: the flow as state and
 * actions (`createMincaAuth`), and the pieces it is made of.
 *
 * Browser-only — it reaches for IndexedDB, WebAuthn and the File System Access
 * API when used — so it lives on its own entry point, away from the
 * isomorphic core.
 */
export { createMincaAuth } from './auth.js';
export { passwordStrength } from './password-strength.js';
export type { PasswordCheck, PasswordStrength } from './password-strength.js';
export type {
  MincaAuth,
  MincaAuthConfig,
  AuthState,
  AuthStage,
  AuthSetup,
  AuthError,
  AccountEntry,
  MincaSession,
  MovedToPod,
  Connection,
  GrantChoice,
  ProposeChoice,
} from './auth.js';
export { createMincaConnection } from './connection.js';
export type {
  MincaConnection,
  MincaConnectionConfig,
  MincaConnectionState,
  ConnectionStatus,
} from './connection.js';
export {
  connectToHome,
  connectCarrier,
  keyProof,
  checkKeyProof,
  checkGrant,
  proposeToHome,
  isProposeRequest,
  homeAddress,
  receiveConnectRequest,
  startConnectedNode,
  nodeOptionsFromGrant,
  joinGranted,
  grantSigner,
  grantStore,
  grantTerms,
  GRANT_VERSION,
  appKey,
  forgetAppKey,
  MAX_GRANT_DAYS,
} from './connect.js';
export type {
  ConnectRequest,
  ConnectOptions,
  ProposeRequest,
  Proposed,
  Grant,
  CarryGrant,
  GrantedSpace,
  IncomingRequest,
  AppKey,
  KeyTerms,
} from './connect.js';
export {
  browserPlace,
  pickPod,
  rememberPod,
  recallPod,
  forgetPod,
  listAccounts,
  inspectPod,
  storesFor,
  deleteBrowserData,
} from './places.js';
export type { Place, PodContents } from './places.js';
export { createStaySignedIn, STAY_SIGNED_IN_CHOICES, DEFAULT_STAY_SIGNED_IN } from './stay-signed-in.js';
export type { StaySignedIn, StaySignedInStore, KeyValueStore } from './stay-signed-in.js';
export { offerToPhone, receiveFromDesktop, readPairingTicket, clearPairingTicket } from './pairing.js';
export { accountHomeLink, readAccountHint, clearAccountHint } from './account-hint.js';
export type { PairingStage, PairingOffer, Handover } from './pairing.js';
export { offerConnectCode, connectWithCode, newConnectCode, readConnectCode } from './connect-code.js';
export type { ConnectCodeStage, ConnectCodeOffer, CodeAsking, ConnectCode } from './connect-code.js';
export { offerToSave, accountCredentialName, recoveryKit } from './credentials.js';
