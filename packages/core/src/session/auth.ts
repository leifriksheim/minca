/**
 * @module session/auth
 * Signing in, as one object any UI can draw: the whole flow as a state you
 * read and actions you call. The recovery code is the account (the seed,
 * written out); a passkey or password wraps the seed for every day; pairing
 * hands it to a new device. The seed stays inside this object, and signs only
 * the note that lets a session key write.
 */
import { isObject, unref } from '../utils/guards.js';
import { createIdentityManager, rootFromSeed } from '../identity/identity-manager.js';
import { accountDataPath, newAccountId, createBrowserAccountStore } from '../identity/account-store.js';
import type { AccountStore, AccountSummary } from '../identity/account-store.js';
import { createVault } from '../identity/account-vault.js';
import {
  withWrap,
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  unwrapSeedWithPassphrase,
  deviceWrapsFor,
  CLI_PASSPHRASE_LABEL,
  deriveLocalKey,
  deriveAccountKey,
  type AccountVault,
  type DeviceWrap,
  type PassphraseWrap,
} from '../identity/account-vault.js';
import { deriveContactKeyBytes, deriveMemberKeyBytes } from '../identity/contact-key.js';
import { createDeviceKey, getDeviceKey, deleteDeviceKey } from '../identity/device-key.js';
import {
  registerPasskey,
  authenticatePasskey,
  hasPlatformAuthenticator,
  renamePasskey,
} from '../identity/webauthn.js';
import {
  generateSeed,
  seedToRecoveryCode,
  recoveryCodeToSeed,
  isValidRecoveryCode,
} from '../identity/recovery-code.js';
import type { PairingTicket } from '../identity/pairing.js';
import { isFolderStorageAvailable } from '../storage/directory-access.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { startPageNode, type WorkerLike } from '../node/worker.js';
import { copyAccountData } from '../node/copy.js';
import type { StoreFactory } from '../node/stores.js';
import type { NodeNetworkConfig, P2PNode } from '../node/types.js';
import { isProtocolError, protocolError, type ProtocolErrorCode } from '../utils/errors.js';
import {
  deleteBrowserData,
  forgetPod,
  inspectPod,
  listAccounts,
  pickPod,
  recallPod,
  rememberPod,
  describeStores,
  storesFor,
  type Place,
  type PodContents,
} from './places.js';
import {
  createStaySignedIn,
  defaultStorage,
  guardedStorage,
  rememberedSessionKey,
  type KeyValueStore,
  type StaySignedIn,
} from './stay-signed-in.js';
import {
  grantTerms,
  GRANT_VERSION,
  MAX_GRANT_DAYS,
  type CarryGrant,
  type ConnectRequest,
  type Grant,
  type GrantedSpace,
  type ProposeRequest,
  type Proposed,
  checkKeyProof,
  requestTerms,
} from './connect.js';
import { fromProposal, proposalSpaces, sameAutomation } from '../space/own-automations.js';
import type { Automation, AutomationApp, AutomationSpaces } from '../schemas/automations.js';
import {
  clearPairingTicket,
  receiveFromDesktop,
  offerToPhone as offerPairing,
  readPairingTicket,
  type PairingOffer,
  type PairingStage,
} from './pairing.js';

export interface MincaAuthConfig {
  /** What passkey prompts call this app. Default "Minca". */
  readonly appName?: string;
  /** Relays and always-on nodes the signed-in node connects to. Omit to stay offline. */
  readonly network?: NodeNetworkConfig;
  /** The site passkeys belong to. Default: this page's hostname. */
  readonly rpId?: string;
  /** Where small choices are remembered — which account, stay signed in. Default `localStorage`. */
  readonly storage?: KeyValueStore | null;
  /** Namespaces those choices, so two apps on one origin keep their own. Default "minca". */
  readonly storageKey?: string;
  /** The page a phone-pairing QR opens. Default: this page. */
  readonly pairingLink?: string;
  /** How long signing out waits, at most, for a peer to take its revokes in. Default 5 s. */
  readonly signOutGraceMs?: number;
  /**
   * Accounts kept in this browser, and their data. Defaults to IndexedDB;
   * swap both for tests or for a host with no IndexedDB.
   */
  readonly browser?: {
    readonly accounts: () => Promise<AccountStore>;
    readonly stores: (account: AccountSummary) => StoreFactory;
  };
  /**
   * Runs the node in a worker, off the page's main thread
   * (`@minca/core/node-worker`). Called once per sign-in; the worker
   * ends when the node closes. Not with `browser.stores`, which a worker
   * can't be handed.
   */
  readonly worker?: () => WorkerLike;
  /**
   * Whether a new account is offered a pod before it goes in (`pod`). Default
   * true. Turn it off where the page closes once signed in, as when an app
   * opened it to connect: the pod is only kept up to date while this page
   * runs, so it is better offered where the person comes back.
   */
  readonly offerPod?: boolean;
}

/**
 * Which screen the flow is on.
 *
 * `welcome` — the place holds no accounts: new here, or not?
 * `existing` — "I already have one": open a pod, use the recovery code, or add this device from another.
 * `signIn` — choose an account and unlock it.
 * `restore` — type the recovery code.
 * `create` — name a new account.
 * `recovery` — signed in, and `freshCode` is the recovery code to keep safe.
 * `unlock` — signed in, choosing a passkey or a password for every day. Required.
 * `pod` — signed in, offered a pod to keep the new account in. Optional.
 * `pair` — opened from a phone-pairing QR code.
 * `ready` — signed in; `session` is set.
 *
 * `recovery`, `unlock` and `pod` already have a session, but the flow is not
 * finished: a screen that waits for `ready` does not show the app halfway.
 */
export type AuthStage =
  | 'starting'
  | 'welcome'
  | 'existing'
  | 'signIn'
  | 'restore'
  | 'create'
  | 'recovery'
  | 'unlock'
  | 'pod'
  | 'pair'
  | 'ready';

/**
 * Why the flow is setting an account up: made just now, opened with its
 * recovery code where it had no everyday way in, or arrived from a pairing
 * link. Decides which of the setup screens are shown.
 */
export type AuthSetup = 'new' | 'restored' | 'paired';

/** A failure, in the shape a screen needs to explain it */
export interface AuthError {
  readonly message: string;
  /** What the person can do about it, when that is known */
  readonly hint?: string;
  readonly code?: ProtocolErrorCode;
}

/** Which ways into an account exist on this site */
export interface AccountEntry {
  readonly summary: AccountSummary;
  readonly vault: AccountVault;
  /**
   * Passkey shortcuts this device can actually use. A wrap names a key in this
   * site's storage, so one made on another site — or before storage was
   * cleared — is listed by the vault but unopenable here.
   */
  readonly shortcuts: ReadonlyArray<DeviceWrap>;
  /** Whether a password unlocks it here */
  readonly hasPassword: boolean;
}

/** An open account: who it is, and the node doing its work */
export interface MincaSession {
  readonly account: AccountSummary;
  /** The account's identity */
  readonly did: string;
  /** The session key's DID — what peers see */
  readonly sessionDid: string;
  readonly node: P2PNode;
}

/** What the last move into a pod did */
export interface MovedToPod {
  /** The pod already held this account, and the two copies were combined */
  readonly merged: boolean;
  readonly spacesAdded: number;
  readonly recordsAdded: number;
  /** The old pod's name, or null when the old place was this browser */
  readonly from: string | null;
}

/** An app this account gave access to, as the home remembers it */
export interface Connection {
  /** Where the app lives — as the browser reported it, not as the app named itself */
  readonly origin: string;
  /** What the app called itself */
  readonly name: string | null;
  /** The app's key */
  readonly audience: string;
  /** `carry` for a carrier, which holds passes and no keys */
  readonly access: 'read' | 'write' | 'carry';
  /** `account` when the app was given the whole account, not chosen spaces */
  readonly scope: 'spaces' | 'account';
  /** A carrier's carry space — what disconnecting takes away */
  readonly carrySpace?: string;
  readonly spaces: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly grantedAt: string;
  /** Unix seconds */
  readonly expiresAt: number;
  /** `code` for a program connected by code through the app at `origin`: its own key, kept apart from the app's own connection */
  readonly via?: 'code';
  /** Present, and true, when its note grants records only */
  readonly recordsOnly?: true;
}

/** Every field a kept connection may have */
const CONNECTION_FIELDS = new Set([
  'origin',
  'name',
  'audience',
  'access',
  'scope',
  'carrySpace',
  'spaces',
  'grantedAt',
  'expiresAt',
  'via',
  'recordsOnly',
]);

/** Whether a kept connection has this shape, and nothing else */
function isConnection(value: unknown): value is Connection {
  if (!isObject(value) || !Object.keys(value).every((field) => CONNECTION_FIELDS.has(field))) return false;
  const { origin, name, audience, access, scope, carrySpace, spaces, grantedAt, expiresAt, via } = value;
  return (
    typeof origin === 'string' &&
    (name === null || typeof name === 'string') &&
    typeof audience === 'string' &&
    (access === 'read' || access === 'write' || access === 'carry') &&
    (scope === 'spaces' || scope === 'account') &&
    (carrySpace === undefined || typeof carrySpace === 'string') &&
    Array.isArray(spaces) &&
    spaces.every(
      (space) => isObject(space) && typeof space.id === 'string' && typeof space.name === 'string',
    ) &&
    typeof grantedAt === 'string' &&
    typeof expiresAt === 'number' &&
    (via === undefined || via === 'code') &&
    (value.recordsOnly === undefined || value.recordsOnly === true)
  );
}

/** What the person chose on the approval screen */
export interface GrantChoice {
  readonly origin: string;
  readonly request: ConnectRequest;
  /** Existing spaces to give the app */
  readonly spaceIds: ReadonlyArray<string>;
  /** How long the note lasts, overriding what the request asked for. Default: the request's `days`, or 7. */
  readonly days?: number;
}

/** What the person chose on the screen for a later proposal */
export interface ProposeChoice {
  readonly origin: string;
  readonly request: ProposeRequest;
  /** Which proposals they said yes to, by index. Default: all of them. */
  readonly kept?: ReadonlyArray<number>;
}

export interface AuthState {
  readonly stage: AuthStage;
  /** Where accounts are being read from */
  readonly place: Place | null;
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly selectedId: string | null;
  /** Ways into the selected account */
  readonly entry: AccountEntry | null;
  readonly session: MincaSession | null;
  /** The recovery code, while the `recovery` screen shows it; cleared by `codeSaved()` */
  readonly freshCode: string | null;
  /** Set while the account is being set up (`recovery`, `unlock`, `pod`) */
  readonly setup: AuthSetup | null;
  /** Something is in progress; buttons should wait */
  readonly busy: boolean;
  readonly error: AuthError | null;
  /** Whether this browser can open a pod at all */
  readonly folderAvailable: boolean;
  /** The phone-pairing link this page was opened with */
  readonly pairing: PairingTicket | null;
  readonly pairingStage: PairingStage | null;
  /** A pod picked while signed in, waiting on what should happen to the data */
  readonly podChoice: { readonly pod: Place; readonly contents: PodContents; readonly from: Place } | null;
  readonly moved: MovedToPod | null;
}

export interface MincaAuth {
  getState(): AuthState;
  /** Called after every change. Returns a function that stops it. */
  subscribe(listener: (state: AuthState) => void): () => void;
  /** Looks for accounts and resumes a kept sign-in. Safe to call more than once. */
  start(): Promise<void>;

  // Where the data lives
  /** Opens a pod. Needs a click. Signed in, it asks what should happen to the data first (`podChoice`). */
  choosePod(): Promise<void>;
  /** Keeps accounts in this browser, and stops using a pod if one was open */
  useBrowser(): Promise<void>;

  // Getting in
  select(accountId: string): Promise<void>;
  /** Opens an account with its recovery code. Where it has no passkey or password yet, sets one up next. */
  signInWithCode(code: string): Promise<void>;
  /** Opens the selected account with its password. A recovery code typed or filled here works too. */
  signInWithPassword(password: string): Promise<void>;
  signInWithPasskey(): Promise<void>;
  startCreating(): void;
  showSignIn(): void;
  /** Back to "new here, or not?" */
  showWelcome(): void;
  /** "I already have an account": the ways to reach one from here */
  showExisting(): void;
  /** The recovery code form, for the selected account if there is one */
  showRestore(): void;
  createAccount(name: string): Promise<void>;
  /** The recovery code has been kept somewhere safe; on to choosing a way in */
  codeSaved(): void;
  /** Leaves the optional `pod` step with the data in this browser */
  finishSetup(): void;
  acceptPairing(): Promise<void>;
  dismissPairing(): void;
  clearError(): void;

  // Once in
  rename(name: string): Promise<boolean>;
  /** Adds a passkey for this site. During setup, moves the flow on. */
  addPasskey(): Promise<boolean>;
  /** Sets or replaces the account's password. During setup, moves the flow on. */
  setPassword(password: string): Promise<boolean>;
  removeShortcut(kind: 'passkey' | 'passphrase'): Promise<boolean>;
  confirmPod(how: 'combine' | 'switch'): Promise<void>;
  cancelPod(): void;
  /** Removes the copy this browser kept after a move into a pod */
  forgetBrowserCopy(): Promise<void>;
  dismissMoved(): void;
  /** The recovery code of the open account. Null when signed out. */
  recoveryCode(): string | null;
  /** Starts offering this account to a phone */
  offerToPhone(onStage: (stage: PairingStage) => void): Promise<PairingOffer>;
  /**
   * Gives an app access, as the account home: makes any spaces it asked for,
   * signs a note from the account to the app's key for these spaces, and
   * remembers the app as connected. The seed signs here and goes nowhere.
   */
  grant(choice: GrantChoice): Promise<Omit<Grant, 'home'>>;
  /**
   * Starts using a carrier, as the account home: makes its carry space, fills
   * it with a pass for every space, and remembers it as connected. The
   * carrier gets no key that reads or writes a space.
   */
  grantCarry(choice: {
    readonly origin: string;
    readonly request: ConnectRequest;
  }): Promise<Omit<CarryGrant, 'home'>>;
  /**
   * Adds the subscriptions an app connected from this home proposed, as the
   * account home — the ones the person kept, naming it, looking only at
   * spaces it may reach.
   * @throws When no app from `origin` is connected here (a carrier or a program connected by code doesn't count), or a proposal names a space it wasn't given
   */
  propose(choice: ProposeChoice): Promise<Proposed>;
  /** Apps this account is connected to from this home, newest first */
  connections(): ReadonlyArray<Connection>;
  /**
   * Other accounts in this place that a carrier at `origin` is connected to from this home.
   * One browser extension carries one account, so connecting it here moves it
   * off theirs — worth saying before it happens.
   */
  connectedElsewhere(origin: string): ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /**
   * Disconnects an app: revokes its note in every space it could write in —
   * and, for a whole-account app, in the account registry — so nothing it
   * writes from now on counts, and forgets it. What this home had
   * seen it write stays. What it could already read, it keeps — reading is
   * holding a space's key, and that is not taken back.
   *
   * Disconnecting an app disconnects the programs connected by code through
   * it too. `{ byCode: true }` disconnects only those programs; `{ audience }`
   * only the one with that key. A carrier at the app's origin is not the app:
   * it stays, and goes only by `{ audience }`, its own key.
   *
   * The app hears of it when the revokes reach it: from this node, or a
   * device that has them. `{ waitMs }` waits up to that long for a peer to
   * take them in, and the answer says whether one did. False means they are
   * still only here: the app keeps working until this home is next online
   * with another of the account's devices or apps.
   */
  disconnect(
    origin: string,
    options?: { readonly byCode?: boolean; readonly audience?: string; readonly waitMs?: number },
  ): Promise<boolean>;
  readonly staySignedIn: {
    choice(): StaySignedIn;
    setChoice(choice: StaySignedIn): Promise<void>;
    until(): Date | null;
  };
  /**
   * Signs this home out on this device: it forgets the unlocked account, lets
   * apps whose time has passed go, and revokes its own session key. The apps
   * connected from here keep their notes until they run out, as apps stay
   * signed in when you sign out of where you signed in to them.
   * `{ disconnect: true }` disconnects them first, and the programs connected
   * through them: their keys are revoked, and each sees it and asks to connect
   * again. Carriers stay: they hold nothing that writes.
   */
  signOut(options?: { readonly disconnect?: boolean }): Promise<void>;
}

/** Files a new account at a place, with no wraps yet: the passkey or password comes after the recovery code. */
async function fileAccount(place: Place, did: string, name: string): Promise<AccountSummary> {
  const id = newAccountId();
  const summary: AccountSummary = {
    id,
    name,
    did,
    createdAt: new Date().toISOString(),
    dataPath: accountDataPath(id),
  };
  await place.store.write(summary, createVault({ did, label: name, wraps: [] }));
  return summary;
}

/** Turns a thrown value into something worth showing, ignoring a dismissed prompt. */
function describe(error: unknown): AuthError | null {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return null; // the person dismissed a passkey or folder prompt
  }
  if (isProtocolError(error)) {
    return { message: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) };
  }
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
}

const afterStorage = (accounts: ReadonlyArray<unknown>): AuthStage =>
  accounts.length > 0 ? 'signIn' : 'welcome';

/**
 * The automations an app's proposals become, for the ones the person kept.
 * Checked whole before any is written: a proposal naming a space the app
 * can't reach refuses them all.
 */
function automationsFrom(
  proposals: ProposeRequest['automations'],
  kept: ReadonlyArray<number> | undefined,
  context: { readonly app: AutomationApp; readonly reach: AutomationSpaces },
): Automation[] {
  const made: Automation[] = [];
  for (const [index, proposal] of proposals.entries()) {
    if (kept && !kept.includes(index)) continue;
    const spaces = proposalSpaces(proposal, context.reach);
    if (!spaces) throw new Error(`“${proposal.name}” looks at a space it was not given.`);
    made.push(fromProposal(proposal, { app: context.app, spaces }));
  }
  return made;
}

/** Adds each, unless the same origin already has the same one */
async function addAutomations(
  node: P2PNode,
  origin: string,
  automations: ReadonlyArray<Automation>,
): Promise<Array<{ id: string; name: string }>> {
  if (automations.length === 0) return [];
  const existing = (await node.automations.list()).filter((own) => own.app?.origin === origin);
  const added: Array<{ id: string; name: string }> = [];
  for (const own of automations) {
    const made = existing.find((found) => sameAutomation(found, own)) ?? (await node.automations.add(own));
    added.push({ id: made.id, name: made.name });
  }
  return added;
}

/** How often a signed-in device looks for app connections whose chosen time has passed */
const EXPIRY_SWEEP_MS = 15 * 60 * 1000;
/** How long signing out waits for its revokes to reach the peers here, at most, unless configured: offline, they wait until next time */
const SIGN_OUT_GRACE_MS = 5000;

/** Creates the sign-in flow for this page. */
export function createMincaAuth(config: MincaAuthConfig = {}): MincaAuth {
  const rpId = config.rpId ?? globalThis.location?.hostname ?? 'localhost';
  const signOutGraceMs = config.signOutGraceMs ?? SIGN_OUT_GRACE_MS;
  const appName = config.appName ?? 'Minca';
  const prefix = config.storageKey ?? 'minca';
  const storage = defaultStorage(config.storage);
  const stay = createStaySignedIn(storage, rpId, prefix);
  const { get, set, read } = guardedStorage(storage);
  /** Proposals being added, in turn */
  let subscribing: Promise<unknown> = Promise.resolve();
  const browserAccounts = config.browser?.accounts ?? createBrowserAccountStore;
  const browserStores = config.browser?.stores ?? ((account: AccountSummary) => storesFor(account));
  if (config.worker && config.browser?.stores)
    throw new Error('A node in a worker opens its own stores: pass worker or browser.stores, not both');

  const LAST_ACCOUNT = `${prefix}.last-account`;

  let state: AuthState = Object.freeze({
    stage: 'starting',
    place: null,
    accounts: [],
    selectedId: null,
    entry: null,
    session: null,
    freshCode: null,
    setup: null,
    busy: false,
    error: null,
    folderAvailable: isFolderStorageAvailable(),
    pairing: readPairingTicket(),
    pairingStage: null,
    podChoice: null,
    moved: null,
  });
  const listeners = new Set<(state: AuthState) => void>();
  const update = (patch: Partial<AuthState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  };

  /** The seed behind the open session. Never leaves this closure except as the recovery code. */
  let seed: Uint8Array | null = null;
  let localKey: CryptoKey | null = null;
  let stopFollowingName: (() => void) | null = null;
  let expiryTimer: ReturnType<typeof setInterval> | null = null;
  let started: Promise<void> | null = null;

  const browserPlace = async (): Promise<Place> => ({
    kind: 'browser',
    store: await browserAccounts(),
    directory: null,
  });

  const storesOf = (place: Place, account: AccountSummary, key: CryptoKey): StoreFactory =>
    place.directory
      ? storesFor(account, { directory: place.directory, localKey: key })
      : browserStores(account);

  // ─── Accounts in a place ───────────────────────────────────────────

  async function openEntry(place: Place, id: string): Promise<AccountEntry | null> {
    const [summary, vault] = await Promise.all([
      listAccounts(place).then((accounts) => accounts.find((account) => account.id === id)),
      place.store.read(id),
    ]);
    if (!summary || !vault) return null;

    // A wrap whose key is missing from this browser cannot be offered, however
    // confidently the vault lists it.
    const usable = await Promise.all(
      deviceWrapsFor(vault, rpId).map(async (wrap) =>
        (await getDeviceKey(wrap.deviceKeyId).catch(() => null)) ? wrap : null,
      ),
    );
    return {
      summary,
      vault,
      shortcuts: usable.filter((wrap): wrap is DeviceWrap => wrap !== null),
      hasPassword: vault.wraps.some((wrap) => wrap.kind === 'passphrase'),
    };
  }

  /** Re-reads the accounts in a place and picks one to expand. */
  async function refresh(place: Place): Promise<ReadonlyArray<AccountSummary>> {
    const accounts = await listAccounts(place);
    const remembered = get(LAST_ACCOUNT);
    const chosen = accounts.find((account) => account.id === remembered) ?? accounts[0] ?? null;
    update({
      place,
      accounts,
      selectedId: chosen?.id ?? null,
      entry: chosen ? await openEntry(place, chosen.id) : null,
    });
    return accounts;
  }

  async function refreshEntry(): Promise<void> {
    if (state.place && state.session)
      update({ entry: await openEntry(state.place, state.session.account.id) });
  }

  // ─── Sessions ──────────────────────────────────────────────────────

  /**
   * Stops the open session's node. The session stays in the state until
   * something replaces it — a restart swaps one session for the next, and
   * signing out moves off the signed-in screens in the same change — so a
   * screen never sees "ready" with no session.
   */
  async function stopNode(node = state.session?.node): Promise<void> {
    stopFollowingName?.();
    stopFollowingName = null;
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
    seed = null;
    localKey = null;
    await node?.close();
  }

  /**
   * Why a key can't be given a note here, or null: it must prove it holds
   * itself, and be no key this home already uses for something else, since
   * disconnecting later revokes it (the node's own, or another connection's).
   */
  async function audienceProblem(request: ConnectRequest, origin: string): Promise<string | null> {
    if (!(await checkKeyProof(request.audience, request.proof, requestTerms(request, origin))))
      return 'The app did not show it holds the key it named, for what it asked.';
    if (request.audience === state.session?.node.sessionDid) return 'That key is this home’s own.';
    // One key is one connection: an app's and a carrier's are never the same key, even from one origin.
    const elsewhere = auth
      .connections()
      .some(
        (known) =>
          known.audience === request.audience &&
          (known.origin !== origin ||
            known.via !== request.via ||
            (known.access === 'carry') !== (request.access === 'carry')),
      );
    return elsewhere ? 'That key is already connected for something else.' : null;
  }

  /**
   * Disconnects the connections `goes` picks: a carrier's carry space goes, a
   * key that could write is revoked, and the automations an app proposed go
   * with it. With `waitMs`, every revoke is written first, and `delivered`
   * settles once a peer has taken them in, or that long has passed: they wait
   * together.
   */
  async function disconnectWhere(
    goes: (known: Connection) => boolean,
    waitMs = 0,
  ): Promise<{ readonly delivered: Promise<boolean> }> {
    const going = auth.connections().filter(goes);
    const node = state.session?.node;
    const revoked: Array<Promise<boolean>> = [];
    for (const connection of going) {
      // One that can't be done must not keep the rest from happening.
      if (connection.carrySpace && node) await node.carriers.remove(connection.carrySpace).catch(() => {});
      if (node) revoked.push(revokeConnection(node, connection, waitMs).catch(() => false));
      // The automations it proposed go with it. So does any its own key wrote, whichever app that one names.
      if (!connection.via && node) {
        for (const own of await node.automations.list()) {
          const wrote = (await node.automations.versions([own.id])).some(
            (version) => version.author === connection.audience,
          );
          // A carrier proposes none: the app's at its origin are the app's, and stay.
          const proposed = own.app?.origin === connection.origin && connection.access !== 'carry';
          if (proposed || wrote) await node.automations.remove(own.id).catch(() => {});
        }
      }
    }
    writeConnections(auth.connections().filter((known) => !goes(known)));
    return { delivered: Promise.all(revoked).then((taken) => taken.every(Boolean)) };
  }

  /**
   * Revokes the key a connection was given, where it could write; never this node's own.
   * With `waitMs`, until a peer has each revoke or that time has passed (they wait together).
   */
  async function revokeConnection(node: P2PNode, connection: Connection, waitMs = 0): Promise<boolean> {
    if (connection.access !== 'write') return true;
    if (connection.audience === node.sessionDid) return true;
    const contactsSpace = await node.contacts.space();
    const writable = (await node.spaces.list()).filter((space) => space.writable).map((space) => space.id);
    // A space the account has left, or no longer writes in, has nothing to revoke, and nobody to tell.
    const covered =
      connection.scope === 'account'
        ? [...writable, ...(contactsSpace ? [contactsSpace] : [])]
        : connection.spaces
            .map((space) => space.id)
            .filter((id) => writable.includes(id) || id === contactsSpace);
    // Every space at once: each is its own store. A space that is gone, or
    // that this account no longer writes in, has nothing to revoke.
    const key = connection.audience;
    const options = { waitMs };
    // One that can't be written (a space gone, or no longer the account's to write in) has
    // nothing to send: it isn't one that went unheard.
    const taken = await Promise.all([
      ...covered.map((spaceId) => node.spaces.revoke(spaceId, key, options).catch(() => true)),
      // A whole-account app could also add spaces to the account's list, and rename it.
      ...(connection.scope === 'account' ? [node.account.revoke(key, options).catch(() => true)] : []),
    ]);
    return taken.every(Boolean);
  }

  /** Disconnects every app connected here whose chosen time has passed */
  async function letExpiredGo(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const known of auth.connections())
      if (known.expiresAt > 0 && known.expiresAt <= now)
        await auth.disconnect(known.origin, { audience: known.audience }).catch(() => {});
  }

  /** Starts the node for an unlocked account. */
  async function startSession(
    place: Place,
    account: AccountSummary,
    unlocked: Uint8Array,
  ): Promise<MincaSession> {
    await stopNode();

    const { identity, signer } = await rootFromSeed(unlocked);
    const key = await deriveLocalKey(unlocked);
    const node = await startPageNode(
      {
        signer,
        accountKey: await deriveAccountKey(unlocked),
        contactKey: await deriveContactKeyBytes(unlocked),
        stores: describeStores(
          account,
          place.directory ? { directory: place.directory, localKey: key } : undefined,
        ),
        ...(config.network ? { network: config.network } : {}),
      },
      config.worker ? { worker: config.worker } : { stores: storesOf(place, account, key) },
    );

    seed = unlocked;
    localKey = key;
    const session: MincaSession = Object.freeze({
      account,
      did: identity.did,
      sessionDid: node.sessionDid,
      node,
    });

    // The account's name follows it: a rename on another device or site
    // arrives through the account registry and is taken here too.
    const adopt = async () => {
      const profile = await node.account.profile().catch(() => null);
      const current = state.session;
      if (!profile || !current || current.node !== node || profile.name === current.account.name) return;
      await adoptName(profile.name).catch(() => {});
    };
    stopFollowingName = node.subscribe((event) => {
      if (event.type === 'account') void adopt();
    });
    void adopt();

    // An app connected for a while: once its time has passed, this device
    // disconnects it, revoking its key, so what it writes after stops counting
    // too, not only its note.
    void letExpiredGo();
    expiryTimer = setInterval(() => void letExpiredGo(), EXPIRY_SWEEP_MS);
    unref(expiryTimer);

    return session;
  }

  /** Records that an account was just used, and starts its session. */
  async function begin(place: Place, summary: AccountSummary, unlocked: Uint8Array): Promise<MincaSession> {
    const used: AccountSummary = { ...summary, lastUsedAt: new Date().toISOString() };
    try {
      const vault = await place.store.read(summary.id);
      if (vault) await place.store.write(used, vault);
    } catch {
      // The order the picker opens in is not worth failing a sign-in over.
    }
    set(LAST_ACCOUNT, summary.id);
    const session = await startSession(place, used, unlocked);
    // So a refresh does not ask again — for as long as the setting allows.
    await stay.remember(summary.id, place.kind, unlocked).catch(() => {});
    return session;
  }

  /** Where a signed-out tab only waits for the person to choose, so taking up a sign-in interrupts nothing */
  const IDLE_STAGES: ReadonlySet<AuthStage> = new Set(['welcome', 'existing', 'signIn']);
  /** The session a take-up started: it goes when the sign-in it took up does */
  let takenUp: MincaSession | null = null;
  /** Which kept sign-in the record holds: its account and the device key that opens it */
  const keptNow = () => {
    const kept = read<{ accountId?: unknown; wrap?: { deviceKeyId?: unknown } }>(
      rememberedSessionKey(prefix),
    );
    return kept ? `${String(kept.accountId)} ${String(kept.wrap?.deviceKeyId)}` : null;
  };
  /** Whether `start()` has finished: before that, it is the one signing in */
  let settledStart = false;
  /** The take-up under way; sign-ins wait for it, so two never start a node at once */
  let takingUp: Promise<void> | null = null;
  /** Sign-ins under way through `run` */
  let running = 0;

  /**
   * Signs in with the sign-in another tab of this browser kept, while this one
   * is signed out and only waiting. A phone pairs in the tab its camera
   * opened, while the app that sent it to sign in waits here; a refresh would
   * do the same.
   */
  function takeUpKept(): void {
    const place = state.place;
    if (takingUp || running > 0 || !settledStart || state.session || state.busy || !place) return;
    if (!IDLE_STAGES.has(state.stage)) return;
    takingUp = (async () => {
      update({ busy: true });
      let started: MincaSession | null = null;
      try {
        const before = keptNow();
        const kept = await stay.recall(place.kind).catch(() => null);
        if (!kept) return;
        // Choosing an account here is the person's answer: another one signed in elsewhere is not.
        if (state.stage === 'signIn' && state.selectedId && state.selectedId !== kept.accountId) return;
        const summary = (await listAccounts(place)).find((account) => account.id === kept.accountId);
        if (!summary) return;
        // The record is already kept; remembering again would replace the key other tabs read.
        set(LAST_ACCOUNT, summary.id);
        started = await startSession(place, summary, kept.seed);
        // Signed out, or into another account, in another tab meanwhile: that wins.
        if (!stay.until() || keptNow() !== before) throw new Error('signed out');
        takenUp = started;
        update({ session: started, stage: 'ready', error: null });
        await refresh(place);
      } catch {
        // Signing in here by hand still works.
        if (started && state.session !== started) await stopNode(started.node).catch(() => {});
      } finally {
        update({ busy: false });
      }
    })().finally(() => {
      takingUp = null;
    });
  }

  /** Runs something that may fail, showing the failure; true when it worked. */
  async function run(work: () => Promise<void>): Promise<boolean> {
    running++;
    try {
      while (takingUp) await takingUp;
      update({ busy: true, error: null });
      await work();
      return true;
    } catch (error) {
      update({ error: describe(error) });
      return false;
    } finally {
      running--;
      update({ busy: false });
    }
  }

  /** Whether an account can be opened here without its recovery code. */
  const hasEverydayWay = (entry: AccountEntry | null): boolean =>
    entry !== null && (entry.shortcuts.length > 0 || entry.hasPassword);

  /**
   * Lands a new session: in, or on through the setup screens.
   *
   * With no reason to set up, or a passkey or password already here, that is
   * the app. Otherwise a new account's recovery code is shown first, then a way
   * in is chosen. A restored account skips the code, since the person just
   * typed it, and so does a paired device, which was never shown one.
   */
  async function arrive(session: MincaSession, setup: AuthSetup | null): Promise<void> {
    const place = state.place;
    const entry = place ? await openEntry(place, session.account.id) : null;
    const landed = {
      session,
      entry,
      selectedId: session.account.id,
      accounts: place ? await listAccounts(place) : state.accounts,
    };
    if (setup === null || hasEverydayWay(entry)) {
      update({ ...landed, stage: 'ready', setup: null, freshCode: null });
    } else if (setup === 'paired' || setup === 'restored') {
      update({ ...landed, stage: 'unlock', setup, freshCode: null });
    } else {
      update({ ...landed, stage: 'recovery', setup, freshCode: seed ? seedToRecoveryCode(seed) : null });
    }
  }

  /** After a way in is set up: offer a pod to a new account that could use one, or go in. */
  function afterUnlock(): void {
    const offerPod =
      config.offerPod !== false &&
      state.setup === 'new' &&
      state.folderAvailable &&
      state.place?.kind === 'browser';
    update(offerPod ? { stage: 'pod' } : { stage: 'ready', setup: null });
  }

  /** Runs a way in. One that took the recovery code may lead on to setting up an everyday one. */
  const enter = (open: () => Promise<{ session: MincaSession; byCode: boolean }>) =>
    run(async () => {
      const { session, byCode } = await open();
      await arrive(session, byCode ? 'restored' : null);
    }).then(() => undefined);

  /**
   * Opens an account from its recovery code, filing it here if this place has
   * not seen it.
   * @param expected The account the person meant, when they picked one
   */
  async function openWithCode(code: string, expected: AccountSummary | null): Promise<MincaSession> {
    const place = state.place;
    if (!place) throw new Error('No place to sign in to yet.');
    if (!isValidRecoveryCode(code)) {
      throw protocolError(
        'VAULT_UNLOCK_FAILED',
        'That is not a recovery code.',
        'A recovery code is 26 letters and digits, usually in groups of four. A password only opens the account where it was ' +
          'set up — on a new device, use the recovery code, or add this device from one that is signed in.',
      );
    }
    const unlocked = recoveryCodeToSeed(code);
    const identity = await createIdentityManager().fromSeed(unlocked);

    if (expected && identity.did !== expected.did) {
      throw protocolError(
        'VAULT_UNLOCK_FAILED',
        `That recovery code opens a different account, not ${expected.name}.`,
        `Check it is the code you kept for ${expected.name}, or restore the account it belongs to instead.`,
      );
    }

    const known = (await listAccounts(place)).find((account) => account.did === identity.did);
    if (known) return begin(place, known, unlocked);

    // New to this place — a new device, or a new home. File it, so there is
    // somewhere to keep the passkey or password set up next.
    return begin(place, await fileAccount(place, identity.did, expected?.name ?? 'My account'), unlocked);
  }

  /** The account the person picked, if any */
  const selectedAccount = (): AccountSummary | null =>
    state.accounts.find((account) => account.id === state.selectedId) ?? null;

  // ─── Passkeys ──────────────────────────────────────────────────────

  /**
   * Makes a passkey to gate this device's key. Nothing is read out of a
   * passkey: the ceremony proves someone is present, and the key that opens
   * the account is in this site's storage, so every provider works. Steers to
   * this device's own authenticator when it has one, since the key it gates
   * never leaves this browser.
   */
  async function passkeyGate(label: string): Promise<{ credentialId: string; userHandle: string }> {
    const platform = await hasPlatformAuthenticator();
    return registerPasskey({
      rpId,
      rpName: appName,
      userName: label,
      ...(platform ? { hints: ['client-device'] as const, attachment: 'platform' as const } : {}),
    });
  }

  /** Rewrites the open account's vault. */
  async function updateVault(make: (vault: AccountVault) => Promise<AccountVault>): Promise<void> {
    const { place, session } = state;
    if (!place || !session) throw new Error('Not signed in.');
    const current = await place.store.read(session.account.id);
    if (!current) throw new Error('That account is no longer here.');
    await place.store.write(session.account, await make(current));
  }

  /** Takes a name for the open account here: the label it is filed under, and its passkey's label. */
  async function adoptName(name: string): Promise<AccountSummary> {
    const { place, session } = state;
    if (!place || !session) throw new Error('Not signed in.');
    const renamed: AccountSummary = { ...session.account, name: name.trim() || session.account.name };

    const vault = await place.store.read(session.account.id);
    if (!vault) throw new Error('That account is no longer here.');
    await place.store.write(renamed, { ...vault, label: renamed.name });

    // Recent browsers let a site relabel its passkey; older ones ignore it.
    for (const wrap of deviceWrapsFor(vault, rpId)) {
      if (wrap.userHandle)
        await renamePasskey({ rpId, userHandle: wrap.userHandle, name: renamed.name }).catch(() => false);
    }
    update({ session: Object.freeze({ ...session, account: renamed }), accounts: await listAccounts(place) });
    return renamed;
  }

  /** Changes to the open account's shortcuts, then re-reads them. During setup, moves the flow on. */
  const changeShortcut = (apply: (unlocked: Uint8Array) => Promise<void>) =>
    run(async () => {
      if (!seed) throw new Error('Not signed in.');
      await apply(seed);
      await refreshEntry();
      if (state.stage === 'unlock' && hasEverydayWay(state.entry)) afterUnlock();
    });

  /**
   * Connected apps are remembered per account, on this device; none when what
   * is kept can't be read. One kept in another shape, such as one from before
   * a field changed meaning, is dropped rather than read in part: its app or
   * program connects again.
   */
  function readConnections(account: string): Connection[] {
    const connections = read<unknown>(`${prefix}.connections:${account}`);
    return Array.isArray(connections) ? connections.filter(isConnection) : [];
  }

  function writeConnections(connections: ReadonlyArray<Connection>): void {
    const account = state.session?.account.id;
    if (account) set(`${prefix}.connections:${account}`, JSON.stringify(connections));
    update({});
  }

  // ─── The flow ──────────────────────────────────────────────────────

  const auth: MincaAuth = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      started ??= (async () => {
        // Only `localStorage` tells other tabs, and only on a page.
        globalThis.addEventListener?.('storage', (event: StorageEvent) => {
          if (event.key !== rememberedSessionKey(prefix)) return;
          if (event.newValue) takeUpKept();
          // The sign-in this tab took up is gone: signed out elsewhere, so here too.
          else if (takenUp && state.session === takenUp) void auth.signOut();
        });
        try {
          // Asks nothing of the person: only whether what was granted before is still live.
          const pod = await recallPod(false).catch(() => null);
          const place = pod ?? (await browserPlace());
          const accounts = await refresh(place);

          if (accounts.length > 0) {
            const kept = await stay.recall(place.kind).catch(() => null);
            const summary = kept && accounts.find((account) => account.id === kept.accountId);
            if (kept && summary) {
              const session = await begin(place, summary, kept.seed);
              // A pairing link still asks first: it would put another account here (spec 01 §15.2).
              update({ session, stage: state.pairing ? 'pair' : 'ready' });
              return;
            }
          }

          if (state.pairing) {
            update({ stage: 'pair' });
            return;
          }
          // Where the data lives is not asked up front: someone new has
          // nothing anywhere, and someone who does finds their pod under
          // "I already have an account".
          update({ stage: afterStorage(accounts) });
        } catch (error) {
          update({ error: describe(error), stage: 'welcome' });
        } finally {
          settledStart = true;
        }
      })();
      return started;
    },

    async choosePod() {
      const picked = await run(async () => {
        const pod = await pickPod();
        const { session, place } = state;
        // Signed in: look before leaping. The picker needed the click, but
        // switching waits for an answer.
        if (session && place) {
          const contents = await inspectPod(pod, place, session.account.did);
          if (contents.same) throw new Error('That is the pod you are already using.');
          update({ podChoice: { pod, contents, from: place } });
          return;
        }
        await rememberPod(pod);
        update({ stage: afterStorage(await refresh(pod)) });
      });

      // Setting up a new account there is nothing to decide: no pod has it
      // yet, so it moves, and the browser copy it leaves is only a shell.
      if (picked && state.stage === 'pod' && state.podChoice) {
        await auth.confirmPod('combine');
        if (state.podChoice) return;
        await auth.forgetBrowserCopy();
        update({ stage: 'ready', setup: null });
      }
    },

    async useBrowser() {
      await run(async () => {
        if (state.place?.kind === 'folder') await forgetPod();
        const place = state.place?.kind === 'browser' ? state.place : await browserPlace();
        update({ stage: afterStorage(await refresh(place)) });
      });
    },

    async select(accountId) {
      update({ selectedId: accountId, error: null });
      if (state.place) update({ entry: await openEntry(state.place, accountId) });
    },

    signInWithCode(code) {
      return enter(async () => ({ session: await openWithCode(code, selectedAccount()), byCode: true }));
    },

    signInWithPassword(password) {
      return enter(async () => {
        const { place, entry } = state;
        // The account's password, and the CLI's passphrase if a pod has one: either opens it.
        const wraps = (entry?.vault.wraps ?? []).filter(
          (candidate): candidate is PassphraseWrap => candidate.kind === 'passphrase',
        );
        // Before passwords, the recovery code was this site's login, and a
        // password manager still fills it here. It opens the account either way.
        const code = isValidRecoveryCode(password) ? password : null;
        let failed: Error | null = null;
        for (const wrap of place && entry ? wraps : []) {
          let unlocked: Uint8Array | null = null;
          try {
            unlocked = await unwrapSeedWithPassphrase(wrap, password, entry!.vault.did);
          } catch (error) {
            failed = error instanceof Error ? error : new Error(String(error));
          }
          if (unlocked) return { session: await begin(place!, entry!.summary, unlocked), byCode: false };
        }
        if (failed && !code) throw failed;
        if (code)
          return { session: await openWithCode(code, entry?.summary ?? selectedAccount()), byCode: true };
        throw protocolError(
          'VAULT_UNLOCK_FAILED',
          'No password is set for this account here.',
          'Use your recovery code, and you can set one up afterwards.',
        );
      });
    },

    signInWithPasskey() {
      return enter(async () => {
        const { place, entry } = state;
        const target = entry?.shortcuts[entry.shortcuts.length - 1];
        if (!place || !entry || !target) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'No passkey on this device can open that account.',
            'Use your recovery code, and you can set one up afterwards.',
          );
        }
        // The gate first, so the key is never reached for without someone present.
        if (target.credentialId) await authenticatePasskey(target.credentialId, { rpId });

        const key = await getDeviceKey(target.deviceKeyId);
        if (!key) {
          throw protocolError(
            'VAULT_UNLOCK_FAILED',
            'The key for that passkey is not in this browser any more.',
            'Clearing site data removes it. Your recovery code still works, and a new passkey can be set up afterwards.',
          );
        }
        return {
          session: await begin(
            place,
            entry.summary,
            await unwrapSeedWithDeviceKey(target, key, entry.vault.did),
          ),
          byCode: false,
        };
      });
    },

    startCreating() {
      update({ error: null, stage: 'create' });
    },

    showSignIn() {
      update({ error: null, stage: 'signIn' });
      // Back from "another account", which let go of the one picked: pick it again.
      if (!state.selectedId && state.place) void refresh(state.place).catch(() => {});
    },

    showWelcome() {
      update({ error: null, stage: 'welcome' });
    },

    showExisting() {
      // Any account, not the one the list had picked: a recovery code from
      // here opens whichever account it belongs to.
      update({ error: null, stage: 'existing', selectedId: null, entry: null });
    },

    showRestore() {
      update({ error: null, stage: 'restore' });
    },

    async createAccount(name) {
      await run(async () => {
        const place = state.place;
        if (!place) throw new Error('No place to keep the account yet.');

        const unlocked = generateSeed();
        const identity = await createIdentityManager().fromSeed(unlocked);
        const summary = await fileAccount(place, identity.did, name.trim());
        // Kept only in this browser, the account is only as safe as the
        // browser's willingness to keep it. Asking costs nothing.
        if (place.kind === 'browser') await globalThis.navigator?.storage?.persist?.().catch(() => false);
        const session = await begin(place, summary, unlocked);
        // The name travels with the account, so the next site it is opened on
        // shows it. Only at creation and on rename — never on a plain start,
        // where a device that has not synced yet would publish a stale name.
        await session.node.account.setName(summary.name).catch(() => {});
        await arrive(session, 'new');
      });
    },

    codeSaved() {
      if (!state.session) return;
      update({ freshCode: null, stage: 'unlock' });
    },

    finishSetup() {
      if (!state.session) return;
      update({ stage: 'ready', setup: null, error: null });
    },

    async acceptPairing() {
      const ticket = state.pairing;
      if (!ticket) return;
      if (!state.place) update({ place: await browserPlace() });
      const onStage = (stage: PairingStage) => update({ pairingStage: stage });
      let spaces: ReadonlyArray<string> = [];
      // The account arrives over the exchange, after the person has compared
      // the codes; the link only says where to meet.
      const opened = await run(async () => {
        const handover = await receiveFromDesktop(ticket, onStage);
        spaces = handover.spaces;
        // Starting the node takes a moment; the code on screen is done with.
        onStage({ kind: 'sending' });
        await arrive(await openWithCode(seedToRecoveryCode(handover.seed), null), 'paired');
      });
      clearPairingTicket();
      update({ pairing: null });
      const session = state.session;
      if (!opened || !session) return;
      let joined = 0;
      for (const [index, invite] of spaces.entries()) {
        onStage({ kind: 'joining', joined: index, total: spaces.length });
        if (
          await session.node.spaces.join(invite).then(
            () => true,
            () => false,
          )
        )
          joined++;
      }
      onStage({ kind: 'received', spaces: joined });
    },

    dismissPairing() {
      clearPairingTicket();
      update({
        pairing: null,
        pairingStage: null,
        stage: state.session ? 'ready' : afterStorage(state.accounts),
      });
    },

    clearError() {
      update({ error: null });
    },

    async rename(name) {
      const session = state.session;
      if (!session) return false;
      return run(async () => {
        const renamed = await adoptName(name);
        // Every other device and site that opens the account follows.
        await session.node.account.setName(renamed.name).catch(() => {});
      });
    },

    addPasskey: () =>
      changeShortcut(async (unlocked) => {
        const session = state.session!;
        const place = state.place!;
        const { credentialId, userHandle } = await passkeyGate(session.account.name);
        const deviceKey = await createDeviceKey();
        const wrap = await wrapSeedWithDeviceKey(unlocked, deviceKey, {
          rpId,
          credentialId,
          userHandle,
          label: rpId,
        });
        // Replacing an older passkey leaves its key behind, opening nothing.
        const previous = deviceWrapsFor((await place.store.read(session.account.id))!, rpId);
        await updateVault(async (vault) => withWrap(vault, wrap));
        for (const stale of previous) await deleteDeviceKey(stale.deviceKeyId);
      }),

    setPassword: (password) =>
      changeShortcut(async (unlocked) => {
        // Any password will do; the form warns about weak ones (`passwordStrength`).
        if (!password) throw new Error('Choose a password.');
        const wrap = await wrapSeedWithPassphrase(unlocked, password, 'Password');
        // One password: the new one replaces the last. The CLI's passphrase is its own, and stays.
        await updateVault(async (vault) => ({
          ...vault,
          wraps: [
            ...vault.wraps.filter(
              (kept) => kept.kind !== 'passphrase' || kept.label === CLI_PASSPHRASE_LABEL,
            ),
            wrap,
          ],
        }));
      }),

    removeShortcut: (kind) =>
      changeShortcut(async () => {
        const session = state.session!;
        if (kind === 'passkey') {
          const vault = await state.place!.store.read(session.account.id);
          for (const wrap of vault ? deviceWrapsFor(vault, rpId) : [])
            await deleteDeviceKey(wrap.deviceKeyId);
        }
        // Removing every shortcut leaves the account openable by its recovery
        // code alone. Another site's passkey is not this one's to remove.
        await updateVault(async (vault) => ({
          ...vault,
          wraps: vault.wraps.filter((wrap) =>
            kind === 'passkey' ? !(wrap.kind === 'device' && wrap.rpId === rpId) : wrap.kind !== 'passphrase',
          ),
        }));
      }),

    async confirmPod(how) {
      const choice = state.podChoice;
      const session = state.session;
      if (!choice || !session || !seed || !localKey) return;
      const unlocked = seed;
      const key = localKey;

      await run(async () => {
        const { pod, contents, from } = choice;
        if (!pod.directory) throw new Error('That is not a folder.');
        const land = async (summary: AccountSummary, moved: MovedToPod | null) => {
          await rememberPod(pod);
          const started = await begin(pod, summary, unlocked);
          update({ session: started, place: pod, accounts: await listAccounts(pod), podChoice: null, moved });
        };

        // Switch: use the pod's own copy and bring nothing; what was only here stays here.
        if (how === 'switch' && contents.account) return land(contents.account, null);

        // Combine: every record is signed and named by its content, and deletes
        // are records too, so two copies merge by keeping everything from both.
        const existing = contents.account;
        const id = existing?.id ?? newAccountId();
        const summary: AccountSummary = existing
          ? { ...existing, lastUsedAt: new Date().toISOString() }
          : { ...session.account, id, dataPath: accountDataPath(id), lastUsedAt: new Date().toISOString() };

        // Ways of unlocking: the pod's, plus any from here it lacks.
        const here = await from.store.read(session.account.id);
        let vault =
          (existing ? await pod.store.read(existing.id) : null) ??
          createVault({ did: session.account.did, label: session.account.name, wraps: [] });
        for (const wrap of here?.wraps ?? []) {
          if (!vault.wraps.some((kept) => kept.id === wrap.id)) vault = withWrap(vault, wrap);
        }
        await pod.store.write(summary, vault);

        const copied = await copyAccountData({
          from: storesOf(from, session.account, key),
          to: storesOf(pod, summary, key),
          did: session.account.did,
          accountKey: await deriveAccountKey(unlocked),
        });

        await land(summary, {
          merged: existing !== null,
          spacesAdded: copied.spacesAdded,
          recordsAdded: copied.recordsAdded,
          from: from.kind === 'folder' ? (from.directory?.name ?? 'your old pod') : null,
        });
      });
    },

    cancelPod() {
      update({ podChoice: null, error: null });
    },

    async forgetBrowserCopy() {
      const session = state.session;
      if (!session) return;
      await run(async () => {
        const browser = await browserAccounts();
        const copy = (await browser.list()).find((entry) => entry.did === session.account.did);
        if (copy) {
          await browser.remove(copy.id);
          await deleteBrowserData(copy);
        }
        update({ moved: null });
      });
    },

    dismissMoved() {
      update({ moved: null });
    },

    recoveryCode() {
      return seed ? seedToRecoveryCode(seed) : null;
    },

    offerToPhone(onStage) {
      const session = state.session;
      if (!session || !seed) return Promise.reject(new Error('Sign in first.'));
      const location = globalThis.location;
      return offerPairing(
        {
          seed,
          invites: async () =>
            Promise.all(
              (await session.node.spaces.list()).map((space) => session.node.spaces.invite(space.id)),
            ),
          relays: config.network?.relays ?? [],
          link: config.pairingLink ?? (location ? `${location.origin}${location.pathname}` : ''),
        },
        onStage,
      );
    },

    async grant(choice) {
      const session = state.session;
      if (!session || !seed) throw new Error('Sign in first.');
      const { node } = session;
      const { request } = choice;

      if (request.access === 'carry')
        throw new Error('A carrier is given passes, not a note — use grantCarry.');
      const access = request.access;
      const recordsOnly = request.recordsOnly === true;
      const byCode = request.via === 'code';
      const problem = await audienceProblem(request, choice.origin);
      if (problem) throw new Error(problem);
      if (recordsOnly && request.create?.length)
        throw new Error('A key given records only works in spaces that exist — none are made for it.');
      if (recordsOnly && request.contacts)
        throw new Error('A key given records only is not given your contacts.');
      const whole = request.scope === 'account';
      const created = [];
      for (const params of request.create ?? []) created.push(await node.spaces.create(params));
      // With the whole account the app derives the contacts space itself; otherwise it is one more space it is given.
      const contactsSpace = request.contacts && !whole ? await node.contacts.space() : null;
      const ids = [
        ...new Set([
          ...choice.spaceIds,
          ...created.map((space) => space.id),
          ...(contactsSpace ? [contactsSpace] : []),
        ]),
      ];

      const spaces: GrantedSpace[] = [];
      for (const id of ids) {
        const space = await node.spaces.get(id);
        if (!space) throw new Error(`No space ${id} in this account.`);
        // Read-only: what lets the app write is the note, under this account's own role — never a secret of the space's.
        const invite = await node.spaces.invite(id, { write: false });
        // Only for the spaces granted: each opens that space's next key and nothing else.
        const memberKey =
          !whole && space.visibility === 'private'
            ? base64UrlEncode(await deriveMemberKeyBytes(await deriveAccountKey(seed), id))
            : null;
        spaces.push({ id, name: space.name, invite, ...(memberKey ? { memberKey } : {}) });
      }

      const days = Math.min(Math.max(choice.days ?? request.days ?? 7, 1 / 24), MAX_GRANT_DAYS);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 24 * 3600);
      const { signer } = await rootFromSeed(seed);
      const note = await signer.delegate({
        audience: request.audience,
        ...grantTerms(recordsOnly && access === 'write' ? 'records' : access, whole ? 'all' : ids),
        expiration: expiresAt,
      });

      const connection: Connection = {
        origin: choice.origin,
        name: request.name?.slice(0, 80) ?? null,
        audience: request.audience,
        access,
        scope: whole ? 'account' : 'spaces',
        spaces: spaces.map(({ id, name }) => ({ id, name })),
        grantedAt: new Date().toISOString(),
        expiresAt,
        ...(byCode ? { via: 'code' as const } : {}),
        ...(recordsOnly ? { recordsOnly: true as const } : {}),
      };
      // Connecting again replaces the old note. A program connected by code is its own key: connecting one replaces only that one.
      // A carrier at the same origin is not the app, and stays (§2.10).
      const replaced = (known: Connection) =>
        byCode
          ? known.audience === request.audience
          : known.origin === choice.origin && !known.via && known.access !== 'carry';
      // A note it replaces stops too: no time ends it, so revoking does (unless it is the same key, still in use).
      for (const known of auth.connections().filter(replaced))
        if (known.audience !== connection.audience) await revokeConnection(node, known);
      writeConnections([connection, ...auth.connections().filter((known) => !replaced(known))]);

      return {
        v: GRANT_VERSION,
        did: session.did,
        name: session.account.name,
        note,
        access,
        scope: whole ? 'account' : 'spaces',
        spaces,
        ...(whole ? { accountKey: base64UrlEncode(await deriveAccountKey(seed)) } : {}),
        // Never with records only: the contact key opens contact requests and knocks on your doors.
        ...(!recordsOnly && (whole || request.contacts)
          ? { contactKey: base64UrlEncode(await deriveContactKeyBytes(seed)) }
          : {}),
        ...(contactsSpace ? { contactsSpace } : {}),
        ...(config.network?.relays?.length ? { relays: [...config.network.relays] } : {}),
        expiresAt,
      };
    },

    async propose({ origin, request, kept }) {
      const session = state.session;
      if (!session) throw new Error('Sign in first.');
      const { node } = session;
      // Only the app itself: a program connected through it by code isn't what the person is looking at, and a carrier can't read what it would notify about.
      const connection = auth
        .connections()
        .find((known) => known.origin === origin && !known.via && known.access !== 'carry');
      if (!connection)
        throw new Error(
          'Only an app connected to your account here may suggest what to notify you about. Connect it first.',
        );
      // What it may reach: every space for a whole-account app, else the spaces it was given, less the contacts space.
      let reach: AutomationSpaces = 'all';
      if (connection.scope === 'spaces') {
        const contactsSpace = connection.spaces.length ? await node.contacts.space().catch(() => null) : null;
        reach = connection.spaces.map((space) => space.id).filter((id) => id !== contactsSpace);
        if (reach.length === 0) throw new Error('It was given no spaces to notify you about.');
      }
      const app = {
        origin,
        ...(connection.name
          ? { name: connection.name }
          : request.name
            ? { name: request.name.slice(0, 80) }
            : {}),
      };
      const made = automationsFrom(request.automations, kept, { app, reach });
      // One at a time: two popups answered together would each find the other's not there yet.
      const adding = subscribing.then(() => addAutomations(node, origin, made));
      subscribing = adding.catch(() => {});
      const automations = await adding;
      // An app with the account key reads them from its own node: handed over now, they are there on its next load.
      if (reach !== 'all' || automations.length === 0) return { v: 2, kind: 'proposed', automations };
      const versions = await node.automations.versions(automations.map((own) => own.id));
      return { v: 2, kind: 'proposed', automations, versions };
    },

    async grantCarry({ origin, request }) {
      const session = state.session;
      if (!session || !seed) throw new Error('Sign in first.');
      const { node } = session;
      const problem = await audienceProblem(request, origin);
      if (problem) throw new Error(problem);
      // One carrier per origin: a new key there replaces the old one. The same key again keeps its
      // carry space (`carriers.add`). An app at the same origin is not it, and stays (§2.10).
      const carrierHere = (known: Connection) => known.origin === origin && known.access === 'carry';
      const previous = auth.connections().find(carrierHere);
      if (previous?.carrySpace && previous.audience !== request.audience)
        await node.carriers.remove(previous.carrySpace).catch(() => {});

      const name = request.name?.slice(0, 80) || 'Browser extension';
      const carry = await node.carriers.add({ did: request.audience, name });
      const connection: Connection = {
        origin,
        name,
        audience: request.audience,
        access: 'carry',
        scope: 'account',
        spaces: [],
        grantedAt: new Date().toISOString(),
        // Carrying has no end date: a pass reads nothing, and the carrier writes nothing.
        expiresAt: 0,
        carrySpace: carry.space,
      };
      writeConnections([connection, ...auth.connections().filter((known) => !carrierHere(known))]);

      const place = state.place;
      return {
        v: 1,
        kind: 'carry',
        did: session.did,
        name: session.account.name,
        carry,
        pod:
          place?.kind === 'folder'
            ? { dataPath: session.account.dataPath, folder: place.directory?.name ?? 'your pod' }
            : null,
        ...(config.network?.relays?.length ? { relays: [...config.network.relays] } : {}),
      };
    },

    connections() {
      const account = state.session?.account.id;
      if (!account) return [];
      return readConnections(account);
    },

    connectedElsewhere(origin) {
      const current = state.session?.account.id;
      return state.accounts
        .filter((account) => account.id !== current)
        .filter((account) =>
          readConnections(account.id).some(
            (connection) => connection.origin === origin && connection.access === 'carry',
          ),
        )
        .map((account) => ({ id: account.id, name: account.name }));
    },

    async disconnect(origin, options = {}) {
      // The app goes with the programs connected through it by code; such a program can go alone.
      // A carrier at the same origin is not the app, and goes only by its own key (§2.10).
      const { delivered } = await disconnectWhere(
        (known) =>
          options.audience !== undefined
            ? known.audience === options.audience
            : known.origin === origin &&
              known.access !== 'carry' &&
              (!options.byCode || known.via === 'code'),
        options.waitMs ?? 0,
      );
      return delivered;
    },

    staySignedIn: {
      choice: () => stay.choice(),
      setChoice: (choice) => stay.setChoice(choice),
      until: () => stay.until(),
    },

    async signOut(options = {}) {
      // Not ready from now on: nothing may be granted from this account while it goes.
      update({ stage: 'starting' });
      await stay.forget();
      const leaving = state.session?.node;
      // Every app and the programs connected through it; carriers stay, holding nothing that writes.
      // The node stops next and sends nothing after, so it waits for a peer to take each revoke in.
      const disconnected = options.disconnect
        ? await disconnectWhere((known) => known.access !== 'carry', signOutGraceMs).catch(() => null)
        : null;
      // Before going: let apps whose time has passed go, and revoke this device's
      // session key, so a key left behind here can't write for the account again.
      // Its revokes and the apps' wait together, up to the one grace.
      await letExpiredGo().catch(() => {});
      await Promise.all([
        disconnected?.delivered,
        leaving?.revokeSelf({ waitMs: signOutGraceMs }).catch(() => {}),
      ]);
      update({
        stage: 'starting',
        session: null,
        entry: null,
        freshCode: null,
        setup: null,
        podChoice: null,
        moved: null,
      });
      await stopNode(leaving).catch(() => {});
      const place = state.place;
      update({ stage: place ? afterStorage(await refresh(place)) : 'welcome' });
    },
  };

  return auth;
}
