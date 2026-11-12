/**
 * @module session
 * What an app and an account home say to each other, and the pieces signing
 * in is made of. The sign-in flow itself is `createMincaAuth` in `@minca/auth`.
 *
 * Browser-only — it reaches for IndexedDB, WebAuthn and the File System Access
 * API when used — so it lives on its own entry point, away from the
 * isomorphic core.
 */
export { createMincaConnection, openAccountHome } from './connection.js';
export type {
  MincaConnection,
  MincaConnectionConfig,
  MincaConnectionState,
  ConnectionStatus,
  ConnectedAccount,
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
  grantExpired,
  usableGrant,
  watchGrant,
  grantTerms,
  requestTerms,
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
  SeededAppKey,
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
  describeStores,
  podToReopen,
  deleteBrowserData,
} from './places.js';
export type { Place, PodContents } from './places.js';
export {
  createStaySignedIn,
  STAY_SIGNED_IN_CHOICES,
  defaultStorage,
  guardedStorage,
  rememberedSessionKey,
} from './stay-signed-in.js';
export type { StaySignedIn, StaySignedInStore, KeyValueStore } from './stay-signed-in.js';
export { offerToPhone, receiveFromDesktop, readPairingTicket, clearPairingTicket } from './pairing.js';
export { readAccountHint, clearAccountHint } from './account-hint.js';
export { popupFeatures } from './popup.js';
export type { PairingStage, PairingOffer, Handover } from './pairing.js';
export {
  answerConnectCode,
  connectWithCode,
  connectCodeIn,
  connectCodeUrl,
  newConnectCode,
  receiveConnectCode,
} from './connect-code.js';
export type { ConnectCodeStage, CodeAsking } from './connect-code.js';
