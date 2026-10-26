/**
 * @module session/connect
 * An app using an account without ever seeing its seed. The app opens the
 * account home in a popup with its own non-exportable key; the person approves
 * there, and the home signs a note (a delegation) letting that key write in the
 * spaces given, which every peer checks. The two sides talk by `postMessage`,
 * each checking the other's origin as the browser reports it.
 */
import { createP256Provider } from '../identity/crypto-p256.js';
import { didOf, didToPublicKey } from '../identity/did.js';
import { canonicalize } from '../schema/version.js';
import { idbOnce } from '../identity/idb.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import {
  ALL_COMMAND,
  grantsRecordsOnly,
  noteTerms,
  READ_COMMAND,
  RECORDS_COMMAND,
  type NoteTerms,
} from '../identity/abilities.js';
import type { RootSigner } from '../identity/root-signer.js';
import { startPageNode, type WorkerLike } from '../node/worker.js';
import type { StoreFactory } from '../node/stores.js';
import type { Version } from '../types.js';
import type { CacheConfig, NewSpace, NodeNetworkConfig, P2PNode } from '../node/types.js';
import { checkFoundingRoles } from '../space/grants.js';
import { parseSpaceInvite } from '../space/space-manager.js';
import { soleFounder } from '../space/constitution.js';
import { checkProposal, MAX_PROPOSALS, type AutomationProposal } from '../space/own-automations.js';
import { defaultStorage, guardedStorage, type KeyValueStore } from './stay-signed-in.js';
import { isObject, unref } from '../utils/guards.js';

/** Messages between an app and the home it opened */
const HELLO = 'minca:hello';
const REQUEST = 'minca:request';
const GRANT = 'minca:grant';
const DENIED = 'minca:denied';

/** What an app asks a home for */
export interface ConnectRequest {
  readonly v: 1;
  /** The app's key — the note is made out to it */
  readonly audience: string;
  /**
   * That key's signature over what it agreed to (`keyProof`): its DID, how it
   * reached the app (`via`) and whether it asked for records only. So a
   * request can only name a key its sender holds, for what that key asked:
   * disconnecting revokes the key, and must never revoke someone else's.
   */
  readonly proof: string;
  /** What the app calls itself. Shown, but never trusted: the home shows the origin too. */
  readonly name?: string;
  /**
   * `write` to change the spaces it is given, `read` only to look. `carry` is
   * for a carrier — a browser extension keeping the spaces online — which gets
   * passes and no keys (`connectCarrier`).
   */
  readonly access: 'read' | 'write' | 'carry';
  /**
   * `spaces` (the default): only the spaces the person picks, and any made for
   * the app. `account`: every space, the account's space list, and making and
   * joining spaces itself — for an app that is a view onto the whole account.
   * Either way the app never gets the seed.
   */
  readonly scope?: 'spaces' | 'account';
  /** Spaces the home should make for the app, and give it */
  readonly create?: ReadonlyArray<NewSpace>;
  /**
   * The account's contacts: the contacts space, and the contact key that opens
   * contact requests sent to the account. Asking someone, or accepting, also
   * needs `account` scope — both make or join a space for two.
   */
  readonly contacts?: boolean;
  /** Whether to offer the person's existing spaces to pick from. Default true. */
  readonly chooseSpaces?: boolean;
  /**
   * A note that grants writing records and nothing more (`/record`), so
   * every peer refuses its key changing a space's collections or who may do
   * what, or writing in the account's own spaces. No contact key, no spaces
   * made for it, and no carrying.
   */
  readonly recordsOnly?: boolean;
  /**
   * `code`: the key is a program's, which reached the home itself over a
   * connect code (`connect-code.ts`); the home makes such a request, an app
   * never sends one. The home keeps its connection by its key. Absent: an
   * app's own key.
   */
  readonly via?: 'code';
  /** How many days the note should last, 1–365. The home decides; default 7. */
  readonly days?: number;
}

/**
 * What an app already connected to a home asks for when the person wants to
 * be notified: automations of the account's own, and nothing else. Never part of connecting — a
 * person signing in has asked for nothing yet. The home knows the app by the
 * origin the browser reports, and refuses one it has no connection for, a
 * carrier's and a program's connected by code.
 */
export interface ProposeRequest {
  readonly v: 2;
  readonly kind: 'propose';
  /** What it calls itself. Shown, never trusted. */
  readonly name?: string;
  /** 1 to 8 automations to offer the person */
  readonly automations: ReadonlyArray<AutomationProposal>;
}

/** What the home answers a {@link ProposeRequest} with, once the person decided */
export interface Proposed {
  readonly v: 2;
  readonly kind: 'proposed';
  /** The automations added or found, by the person's yes: none when they kept none */
  readonly automations: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /**
   * For an app given the whole account: every version of those automations,
   * signed, so its node holds them at once rather than once it meets another
   * of the account's devices, which may be long after the home's window closed.
   */
  readonly versions?: ReadonlyArray<Version>;
}

/** Whether a request the home received is a proposal rather than a connection */
export const isProposeRequest = (request: ConnectRequest | ProposeRequest): request is ProposeRequest =>
  'kind' in request && request.kind === 'propose';

/** The longest a home gives a note for */
export const MAX_GRANT_DAYS = 365;

/** A space an app was given */
export interface GrantedSpace {
  readonly id: string;
  readonly name: string;
  /** What the app joins it with — carrying the key, for a private space */
  readonly invite: string;
  /**
   * For a private space: the account's member key there (base64url,
   * `deriveMemberKeyBytes`), which opens the space's next key when it
   * changes. It opens nothing else.
   */
  readonly memberKey?: string;
}

/** A grant's format: 2 since its note is a delegation in the UCAN 1.0 profile (spec 01 §7) */
export const GRANT_VERSION = 2;

/** What the home hands back when the person approves */
export interface Grant {
  readonly v: typeof GRANT_VERSION;
  /** The account's identity — what the app acts for */
  readonly did: string;
  /** The account's name, for showing who is connected */
  readonly name: string;
  /** The signed note: the account → the app's key, for these spaces, until `expiresAt` */
  readonly note: Delegation;
  readonly access: 'read' | 'write';
  readonly scope: 'spaces' | 'account';
  readonly spaces: ReadonlyArray<GrantedSpace>;
  /**
   * With `account` scope: the key the account's space list is derived from
   * (base64url), so the app sees every space and adds the ones it makes or
   * joins. It opens every private space in the account — which is what whole
   * account access means — but it cannot sign as the account.
   */
  readonly accountKey?: string;
  /**
   * With `contacts`, or `account` scope: the contact key's private scalar
   * (base64url), which opens contact requests sent to the account
   * (`deriveContactKeyBytes`). It cannot sign as the account.
   */
  readonly contactKey?: string;
  /** With `contacts`: which of `spaces` is the account's contacts space */
  readonly contactsSpace?: string;
  /** Unix seconds */
  readonly expiresAt: number;
  /** The home that granted it, so the app can go back there */
  readonly home: string;
  /**
   * Relays the home meets peers on. A home someone runs themselves may use
   * different ones from the app, and two peers that share no relay never
   * meet — so the app joins these as well.
   */
  readonly relays?: ReadonlyArray<string>;
}

/**
 * What the home hands a carrier: a way into its carry space, which holds a
 * pass for each of the account's spaces — and nothing that reads or writes
 * them (`space/pass.ts`).
 */
export interface CarryGrant {
  readonly v: 1;
  readonly kind: 'carry';
  /** The account it carries for */
  readonly did: string;
  /** The account's name, for showing whose spaces these are */
  readonly name: string;
  /** The carry space, and the view-only invite to it */
  readonly carry: { readonly space: string; readonly invite: string };
  /**
   * Where the account keeps its data, when it lives in a pod: the path inside
   * the pod folder, and the folder's name to help the person find it. Null
   * when the account lives in the home's browser storage.
   */
  readonly pod: { readonly dataPath: string; readonly folder: string } | null;
  readonly relays?: ReadonlyArray<string>;
  /** The home that granted it */
  readonly home: string;
}

/**
 * Turns what a person typed into a home's connect page:
 * `minca.example.com` → `https://minca.example.com/connect`. Plain `http` only
 * for this machine, where development happens.
 * @throws When it is not a web address
 */
export function homeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Type the address of your account home.');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${local ? 'http' : 'https'}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Browsers parse more than they should ("not a url" becomes a host), so ask
  // for a name that could be a real domain.
  if (!loopback && !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)) {
    throw new Error(`"${trimmed}" is not a web address.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('An account home must be on https.');
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/connect';
  url.hash = '';
  url.search = '';
  return url.href;
}

/**
 * The terms of the note a grant carries, for these spaces. Writing is every
 * command; `records` is records only, for a key the account trusts less: it
 * can't define collections, change who may do what, or write for the
 * account (`identity/abilities.ts`).
 */
export function grantTerms(
  access: 'read' | 'write' | 'records',
  spaceIds: ReadonlyArray<string> | 'all',
): NoteTerms {
  const command = access === 'write' ? ALL_COMMAND : access === 'records' ? RECORDS_COMMAND : READ_COMMAND;
  return noteTerms(command, spaceIds);
}

// ─── The app's side ──────────────────────────────────────────────────

/** What a key signs to show it is the one a connect request names */
const KEY_PROOF = 'minca/connect-key/v1';

/**
 * What a key agrees to in a connect request: how it reached the home, how
 * much it asks for, and, for a program's key handed over a code, the home it
 * was handed to.
 */
export type KeyTerms =
  /** An app's own key */
  | { readonly via: 'popup'; readonly recordsOnly: boolean }
  /** A program's key, handed to the home at `origin` over a connect code */
  | { readonly via: 'code'; readonly recordsOnly: boolean; readonly origin: string };

/**
 * The statement, terms included: a proof a program hands a home over a code
 * can't ask for an app's connection, nor for more than records, nor be used
 * at another home.
 */
const keyStatement = (audience: string, terms: KeyTerms) =>
  utf8Encode(
    canonicalize({
      audience,
      ...(terms.via === 'code' ? { origin: terms.origin } : {}),
      proof: KEY_PROOF,
      recordsOnly: terms.recordsOnly,
      via: terms.via,
    }),
  );

/** The terms a request names, as the home received it from `origin` */
export const requestTerms = (
  request: Pick<ConnectRequest, 'via' | 'recordsOnly'>,
  origin: string,
): KeyTerms =>
  request.via === 'code'
    ? { via: 'code', recordsOnly: request.recordsOnly === true, origin }
    : { via: 'popup', recordsOnly: request.recordsOnly === true };

/** A key's proof that it holds itself, for a connect request with these terms (`ConnectRequest.proof`) */
export async function keyProof(
  key: { readonly keys: CryptoKeyPair; readonly did: string },
  terms: KeyTerms = { via: 'popup', recordsOnly: false },
): Promise<string> {
  return base64UrlEncode(await createP256Provider().sign(key.keys.privateKey, keyStatement(key.did, terms)));
}

/** Whether `proof` was made by the key `audience` names, for a request with these terms */
export async function checkKeyProof(audience: string, proof: unknown, terms: KeyTerms): Promise<boolean> {
  if (typeof proof !== 'string') return false;
  try {
    const provider = createP256Provider();
    const publicKey = await provider.importPublicKey(didToPublicKey(audience).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(proof), keyStatement(audience, terms));
  } catch {
    return false;
  }
}

export interface AppKey {
  readonly keys: CryptoKeyPair;
  readonly did: string;
}

const KEY_DB = 'minca-app-key';

/**
 * This app's key: made once, kept in this site's IndexedDB, and never
 * exportable — a script that gets into the page can sign with it while it is
 * there, but cannot carry it off.
 */
export async function appKey(name = 'default'): Promise<AppKey> {
  const stored = await idbOnce(KEY_DB, 'keys', 'readonly', (store) => store.get(name));
  let keys = isKeyPair(stored) ? stored : null;
  if (!keys) {
    const { privateKey, publicKey } = await createP256Provider().generateKeyPair();
    keys = { privateKey, publicKey };
    await idbOnce(KEY_DB, 'keys', 'readwrite', (store) => store.put(keys, name));
  }
  return { keys, did: await didOf(keys.publicKey) };
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  return isObject(value) && value.privateKey instanceof CryptoKey && value.publicKey instanceof CryptoKey;
}

/** Forgets this app's key. The next connection makes a new one. */
export async function forgetAppKey(name = 'default'): Promise<void> {
  await idbOnce(KEY_DB, 'keys', 'readwrite', (store) => store.delete(name));
}

export interface ConnectOptions {
  /** The home's connect page, e.g. `https://minca.example/connect` */
  readonly home: string;
  /** What to ask for; `audience`, `proof` and `via` are filled in */
  readonly request: Omit<ConnectRequest, 'v' | 'audience' | 'proof' | 'via'>;
  /** The key to ask for, or its promise, awaited once the popup is open. Default: {@link appKey} under `keyName`. */
  readonly key?: AppKey | Promise<AppKey>;
  /** Which of this app's keys to use when `key` is not given. Default `default`. */
  readonly keyName?: string;
  /** How long to wait for the person. Default 10 minutes. */
  readonly timeoutMs?: number;
}

/**
 * Opens the home and asks for access. Call it from a click — browsers only
 * allow a popup that a person asked for.
 *
 * @returns The grant, checked: signed by the account, made out to this app's key
 * @throws When the popup is blocked, closed, denied, or the answer does not check out
 */
export async function connectToHome(options: ConnectOptions): Promise<Grant> {
  const homeUrl = new URL(options.home, globalThis.location.href);
  // Opened before anything is awaited, so it still counts as the click's.
  const popup = openHome(homeUrl);
  const request = (async (): Promise<ConnectRequest> => {
    const key = (await options.key) ?? (await appKey(options.keyName));
    const proof = await keyProof(key, { via: 'popup', recordsOnly: options.request.recordsOnly === true });
    return { v: 1, audience: key.did, proof, ...options.request };
  })();
  const grant = await askHome<Grant>(popup, homeUrl.origin, request, options.timeoutMs);
  const { audience } = await request;
  await checkGrant(grant, audience, { recordsOnly: options.request.recordsOnly === true });
  return { ...grant, home: homeUrl.href };
}

/**
 * Asks a home to use this carrier — a browser extension, say — for the
 * account. Call it from a click, in a page that stays open until the answer
 * comes: an extension's toolbar popup closes the moment the home's window
 * takes focus, and the answer would have nowhere to go.
 *
 * @param options.key The carrier's own key; it becomes its name to peers
 * @returns The grant, checked: an invite to a private carry space the account made
 */
export async function connectCarrier(options: {
  readonly home: string;
  readonly key: AppKey;
  readonly name?: string;
  readonly timeoutMs?: number;
}): Promise<CarryGrant> {
  const homeUrl = new URL(options.home, globalThis.location.href);
  const popup = openHome(homeUrl);
  const request = keyProof(options.key).then((proof): ConnectRequest => ({
    v: 1,
    audience: options.key.did,
    proof,
    access: 'carry',
    ...(options.name ? { name: options.name } : {}),
  }));
  const grant = await askHome<CarryGrant>(popup, homeUrl.origin, request, options.timeoutMs);
  checkCarryGrant(grant);
  return { ...grant, home: homeUrl.href };
}

/**
 * Offers the person automations that notify them, from an app already connected to their
 * home. Call it from a click on something that asked for it — "Notify me" —
 * in a page that stays open: the home opens in a popup, and the person keeps
 * the ones they want. The app shows the notifications itself
 * (`watchNotifications`).
 *
 * @param options.home The home it connected to — a grant's `home`
 * @returns What the home added or found; an empty list when the person kept none
 * @throws When the popup is blocked, closed or denied, or the home knows no connection from here
 */
export async function proposeToHome(options: {
  readonly home: string;
  readonly automations: ReadonlyArray<AutomationProposal>;
  readonly name?: string;
  readonly timeoutMs?: number;
}): Promise<Proposed> {
  if (options.automations.length === 0 || options.automations.length > MAX_PROPOSALS)
    throw new Error(`Propose 1 to ${MAX_PROPOSALS} automations.`);
  const homeUrl = new URL(options.home, globalThis.location.href);
  const popup = openHome(homeUrl);
  const request: ProposeRequest = {
    v: 2,
    kind: 'propose',
    ...(options.name ? { name: options.name } : {}),
    automations: options.automations,
  };
  const answer = await askHome<Proposed | null>(popup, homeUrl.origin, request, options.timeoutMs);
  if (answer?.kind !== 'proposed' || !Array.isArray(answer.automations))
    throw new Error('Your account home did not answer the proposal.');
  return answer;
}

/** Refuses a carry grant that is not an invite to a private space the account made. */
function checkCarryGrant(grant: CarryGrant): void {
  if (grant?.kind !== 'carry' || typeof grant.did !== 'string' || typeof grant.carry?.invite !== 'string') {
    throw new Error('The home did not answer with a way to carry your spaces.');
  }
  const invite = parseSpaceInvite(grant.carry.invite);
  if (
    invite.space.id !== grant.carry.space ||
    soleFounder(invite.space) !== grant.did ||
    invite.space.visibility !== 'private' ||
    !invite.key
  ) {
    throw new Error('The carry space the home named does not check out.');
  }
  if (
    grant.pod !== null &&
    (typeof grant.pod?.dataPath !== 'string' ||
      grant.pod.dataPath.split('/').some((part) => !part || part === '..'))
  ) {
    throw new Error('The pod the home named does not check out.');
  }
}

function openHome(homeUrl: URL): Window {
  const popup = globalThis.open(homeUrl.href, 'minca-home', 'popup,width=460,height=720');
  if (!popup) throw new Error('The browser blocked the window. Allow pop-ups for this site and try again.');
  return popup;
}

/**
 * Sends the request when the home says hello, and again every half second
 * until it answers, only ever to the home's origin; then waits for the answer,
 * which the caller checks. A phone may hardly run this page while the home is
 * in front, so the hello can arrive before the request is made, or be missed:
 * it listens from the start, and the repeats reach a home that has loaded.
 */
function askHome<T>(
  popup: Window,
  homeOrigin: string,
  request: Promise<ConnectRequest | ProposeRequest> | ConnectRequest | ProposeRequest,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const done = (finish: () => void) => {
      if (finished) return;
      finished = true;
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearInterval(watch);
      globalThis.clearTimeout(timer);
      finish();
    };
    let made: ConnectRequest | ProposeRequest | null = null;
    // Until the home says hello, the popup may still be a blank page of this origin: posting there only logs an error.
    let heard = false;
    const send = () => {
      if (made && heard && !finished) popup.postMessage({ type: REQUEST, request: made }, homeOrigin);
    };
    const ready = Promise.resolve(request);
    ready.then(
      (value) => {
        made = value;
      },
      () => {},
    );
    ready.catch((error: unknown) =>
      done(() => {
        popup.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }),
    );
    const onMessage = (event: MessageEvent) => {
      // Only the popup we opened, at the address we opened it on.
      if (event.source !== popup || event.origin !== homeOrigin) return;
      const data: unknown = event.data;
      if (!isObject(data)) return;
      if (data.type === HELLO) {
        heard = true;
        void ready.then(send, () => {});
      } else if (data.type === GRANT && data.grant)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant, checkCarryGrant and proposeToHome check it
        done(() => resolve(data.grant as T));
      else if (data.type === DENIED)
        done(() =>
          reject(new Error(typeof data.reason === 'string' ? data.reason : 'Access was not given.')),
        );
    };
    const watch = globalThis.setInterval(() => {
      if (popup.closed) done(() => reject(new Error('The window was closed before access was given.')));
      // Until the home answers; one that has its request already ignores the rest.
      else send();
    }, 500);
    const timer = globalThis.setTimeout(
      () => done(() => reject(new Error('No answer from your account home.'))),
      timeoutMs,
    );
    globalThis.addEventListener('message', onMessage);
  });
}

/**
 * Refuses a grant that is not a valid note from the account to this key, or,
 * when records only were asked for, one that grants more.
 */
export async function checkGrant(
  grant: Grant,
  audience: string,
  asked: { readonly recordsOnly?: boolean } = {},
): Promise<void> {
  if (!isObject(grant) || grant.v !== GRANT_VERSION || typeof grant.did !== 'string') {
    throw new Error('That is not a grant.');
  }
  const verified = await verifyNote(grant.note, createP256Provider());
  if (!verified.valid) throw new Error(`The grant does not check out: ${verified.reason}`);
  if (verified.audience !== audience) throw new Error('The grant was made out to a different key.');
  if (verified.root !== grant.did) throw new Error('The grant was not signed by the account it names.');
  if (asked.recordsOnly && !grantsRecordsOnly(grant.note))
    throw new Error('The grant gives more than records, which is all that was asked for.');
}

/**
 * A signer that answers with the note the home gave — the app holds nothing
 * else. Given a getter, it answers with whichever grant is current.
 */
export function grantSigner(grant: Grant | (() => Grant | null)): RootSigner {
  const current = typeof grant === 'function' ? grant : () => grant;
  return {
    get did() {
      return current()?.did ?? '';
    },
    async delegate() {
      const now = current();
      if (!now || grantExpired(now))
        throw new Error('Access has run out. Connect to your account home again.');
      return now.note;
    },
  };
}

/** Whether a grant's note has run out */
export const grantExpired = (grant: Pick<Grant, 'expiresAt'>): boolean =>
  grant.expiresAt <= Math.floor(Date.now() / 1000);

/**
 * Watches a node started under a grant: `onExpired` once its note runs out,
 * `onRevoked` for each space where the home revoked its key.
 * @returns How to stop watching
 */
export function watchGrant(
  node: Pick<P2PNode, 'subscribe'>,
  grant: Pick<Grant, 'expiresAt'>,
  on: { readonly onExpired?: () => void; readonly onRevoked?: (space: string) => void },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A timer waits at most 2^31 − 1 ms, some 24 days: a note that runs longer is looked at again then.
  const arm = () => {
    const left = Math.min(Math.max(grant.expiresAt * 1000 - Date.now(), 0), 2 ** 31 - 1);
    timer = globalThis.setTimeout(() => (grantExpired(grant) ? on.onExpired?.() : arm()), left);
    // It says when the note ran out; it is no reason for a process to stay up.
    unref(timer);
  };
  if (on.onExpired) arm();
  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'revoked') on.onRevoked?.(event.space);
  });
  return () => {
    globalThis.clearTimeout(timer);
    unsubscribe();
  };
}

/** Whether a kept grant still works: one kept in an older format holds a note no peer reads now */
export const usableGrant = (grant: Grant | null): boolean =>
  !!grant && grant.v === GRANT_VERSION && !grantExpired(grant);

/**
 * Starts a node acting for the account, under a grant.
 *
 * It joins the granted spaces (again, harmlessly, on later starts) and keeps
 * its data in this site's storage. It has no account key: it sees the spaces
 * it was given, not the account's whole list.
 *
 * In a space that names a keeper it holds only the collections the app uses
 * (`cache`); pass `cache: false` to hold every space whole.
 */
export async function startConnectedNode(params: {
  readonly grant: Grant;
  readonly key?: AppKey;
  readonly network?: NodeNetworkConfig;
  readonly stores?: StoreFactory;
  readonly cache?: CacheConfig | false;
  /** Runs the node in a worker, off the page's main thread. Not with `stores`, which a worker can't be handed. */
  readonly worker?: () => WorkerLike;
}): Promise<P2PNode> {
  const key = params.key ?? (await appKey());
  const { relays, ...keys } = nodeOptionsFromGrant(params.grant, params.network?.relays);
  const network = params.network || relays.length ? { ...params.network, relays } : undefined;
  const node = await startPageNode(
    {
      signer: grantSigner(params.grant),
      sessionKey: key.keys,
      stores: { indexedDB: `minca-app:${params.grant.did}` },
      ...(network ? { network } : {}),
      ...(params.cache === false ? {} : { cache: params.cache ?? {} }),
      ...keys,
    },
    params,
  );
  await joinGranted(node, params.grant);
  return node;
}

/**
 * What a node started under a grant takes from it: the keys it carries, and
 * the home's relays as well as the app's, so the two always share one.
 */
export function nodeOptionsFromGrant(grant: Grant, relays: ReadonlyArray<string> = []) {
  return {
    relays: [...new Set([...relays, ...(grant.relays ?? [])])],
    ...(grant.accountKey ? { accountKey: base64UrlDecode(grant.accountKey) } : {}),
    // Never under records only, whatever the home sent: it opens contact requests and knocks.
    ...(grant.contactKey && !grantsRecordsOnly(grant.note)
      ? { contactKey: base64UrlDecode(grant.contactKey) }
      : {}),
    ...(grant.contactsSpace ? { contactsSpace: grant.contactsSpace } : {}),
  };
}

/**
 * Joins the spaces a grant names that the node doesn't hold yet: again,
 * harmlessly, on later starts. A space that won't join throws, unless
 * `onError` takes it and the rest are joined.
 */
export async function joinGranted(
  node: P2PNode,
  grant: Grant,
  onError?: (error: unknown) => void,
): Promise<void> {
  const held = new Set((await node.spaces.list()).map((space) => space.id));
  for (const { id, invite, memberKey } of grant.spaces) {
    if (held.has(id)) continue;
    const joining = node.spaces.join(invite, memberKey ? { memberKey: base64UrlDecode(memberKey) } : {});
    await (onError ? joining.catch(onError) : joining);
  }
}

/** An account an app is connected to: its grant, and the name of the app key it is made out to ({@link appKey}) */
export interface KeptGrant {
  readonly grant: Grant;
  readonly keyName: string;
}

/**
 * Where an app keeps its grants between visits: one per account, each made
 * out to a key of its own, so two accounts never show peers one key.
 */
export function grantStore(storage: KeyValueStore | null = defaultStorage(), key = 'minca.grants') {
  const kept = guardedStorage(storage);
  const all = (): ReadonlyArray<KeptGrant> =>
    // One kept in an older format holds a note no peer reads now: connecting again replaces it.
    (kept.read<ReadonlyArray<KeptGrant>>(key) ?? []).filter(
      (each) => each?.grant?.v === GRANT_VERSION && typeof each.keyName === 'string',
    );
  return {
    /** Every account, the one connected first first; an expired grant stays, to show and renew */
    list: all,
    get: (did: string): KeptGrant | null => all().find((each) => each.grant.did === did) ?? null,
    save(grant: Grant, keyName: string): void {
      const before = all();
      const found = before.some((each) => each.grant.did === grant.did);
      kept.write(
        key,
        found
          ? before.map((each) => (each.grant.did === grant.did ? { grant, keyName } : each))
          : [...before, { grant, keyName }],
      );
    },
    forget: (did: string): void =>
      kept.write(
        key,
        all().filter((each) => each.grant.did !== did),
      ),
  };
}

// ─── The home's side ─────────────────────────────────────────────────

/** A request as the home received it */
export interface IncomingRequest {
  readonly request: ConnectRequest | ProposeRequest;
  /** Where it came from, as the browser reports it — the only name to trust */
  readonly origin: string;
  /**
   * Sends the answer back to that origin, and closes the window — once
   * `closeAfter` settles, when given: what this window's node wrote for the
   * asker may still have to reach it.
   */
  approve(
    answer: Omit<Grant, 'home'> | Omit<CarryGrant, 'home'> | Proposed,
    closeAfter?: Promise<unknown>,
  ): void;
  /** Says no, and closes the window */
  deny(reason?: string): void;
}

/**
 * Waits for the app that opened this page to say what it wants. It says hello
 * once, and listens long: on a phone the app's tab behind this one may not run
 * for a while, and its request (which it repeats) comes when it does.
 * @returns The request, or null when this page was not opened by an app, the app's window closed, or none came in time
 */
export function receiveConnectRequest(timeoutMs = 10 * 60_000): Promise<IncomingRequest | null> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- lib.dom has it as any, and an opener on another origin is no instanceof Window here
  const opener = globalThis.opener as Window | null;
  if (!opener) return Promise.resolve(null);

  return new Promise((resolve) => {
    const stop = () => {
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearTimeout(timer);
      globalThis.clearInterval(watch);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const data: unknown = event.data;
      if (!isObject(data) || data.type !== REQUEST) return;
      stop();

      // A request this home cannot read — often an app newer than the home —
      // is answered, not ignored: otherwise both sides wait with nothing said.
      if (!isRequest(data.request, event.origin)) {
        opener.postMessage(
          {
            type: DENIED,
            reason:
              'Your account home did not understand what was asked. It may be older than this app — update it, or use another home.',
          },
          event.origin,
        );
        globalThis.setTimeout(() => globalThis.close(), 100);
        resolve(null);
        return;
      }

      const origin = event.origin;
      const reply = (message: unknown, closeAfter?: Promise<unknown>) => {
        opener.postMessage(message, origin);
        // A moment's grace, so the answer is delivered before the window goes.
        const close = () => void globalThis.setTimeout(() => globalThis.close(), 100);
        void (closeAfter ?? Promise.resolve()).then(close, close);
      };
      resolve({
        request: data.request,
        origin,
        approve: (answer, closeAfter) => reply({ type: GRANT, grant: answer }, closeAfter),
        deny: (reason) => reply({ type: DENIED, reason: reason ?? 'Access was not given.' }),
      });
    };
    const timer = globalThis.setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);
    const watch = globalThis.setInterval(() => {
      if (!opener.closed) return;
      stop();
      resolve(null);
    }, 500);
    globalThis.addEventListener('message', onMessage);
    // Nothing secret in a hello, so any origin may hear it; the request that
    // answers it is what names the app. Said once: a page that takes over the
    // app's tab later is not told where this home is.
    opener.postMessage({ type: HELLO }, '*');
  });
}

/** Every field a request may carry; one with any other is refused, not read in part */
const REQUEST_FIELDS = new Set([
  'v',
  'audience',
  'proof',
  'name',
  'access',
  'scope',
  'create',
  'contacts',
  'chooseSpaces',
  'recordsOnly',
  'via',
  'days',
]);
const PROPOSE_FIELDS = new Set(['v', 'kind', 'name', 'automations']);

const onlyFields = (value: Record<string, unknown>, fields: ReadonlySet<string>): boolean =>
  Object.keys(value).every((field) => fields.has(field));

function isRequest(value: unknown, origin: string): value is ConnectRequest | ProposeRequest {
  if (!isObject(value)) return false;
  const proposal = value;
  if (proposal.kind !== undefined) {
    return (
      onlyFields(proposal, PROPOSE_FIELDS) &&
      proposal.v === 2 &&
      proposal.kind === 'propose' &&
      (proposal.name === undefined || (typeof proposal.name === 'string' && proposal.name.length <= 80)) &&
      Array.isArray(proposal.automations) &&
      proposal.automations.length > 0 &&
      isProposals(proposal.automations, origin)
    );
  }
  const request = value;
  return (
    onlyFields(request, REQUEST_FIELDS) &&
    request.v === 1 &&
    typeof request.audience === 'string' &&
    request.audience.startsWith('did:key:') &&
    typeof request.proof === 'string' &&
    request.proof.length <= 200 &&
    (request.access === 'read' || request.access === 'write' || request.access === 'carry') &&
    (request.scope === undefined || request.scope === 'spaces' || request.scope === 'account') &&
    (request.name === undefined || (typeof request.name === 'string' && request.name.length <= 80)) &&
    (request.contacts === undefined || typeof request.contacts === 'boolean') &&
    (request.chooseSpaces === undefined || typeof request.chooseSpaces === 'boolean') &&
    (request.create === undefined || isNewSpaces(request.create)) &&
    (request.days === undefined ||
      (typeof request.days === 'number' &&
        Number.isInteger(request.days) &&
        request.days >= 1 &&
        request.days <= MAX_GRANT_DAYS)) &&
    // A program's key comes to the home over a code (`connect-code.ts`), never from an app.
    request.via === undefined &&
    // Records only: in spaces that exist, none made for it, no contacts and no carrying.
    (request.recordsOnly === undefined ||
      request.recordsOnly === false ||
      (request.recordsOnly === true &&
        request.access !== 'carry' &&
        request.create === undefined &&
        !request.contacts))
  );
}

/** Automations an app proposes: few, each one it could offer, each click leading back to it */
function isProposals(value: unknown, origin: string): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PROPOSALS &&
    value.every((proposal) => checkProposal(proposal, origin) === null)
  );
}

/** At most this many spaces made for an app in one go */
const MAX_CREATE = 8;

/** Spaces an app asks to have made: few, named, with a visibility — the roles are checked when they are made */
function isNewSpaces(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CREATE &&
    value.every(
      (space: Partial<NewSpace> | null) =>
        !!space &&
        typeof space.name === 'string' &&
        space.name.trim().length > 0 &&
        space.name.length <= 80 &&
        (space.visibility === 'private' || space.visibility === 'public') &&
        (space.roles === undefined || checkFoundingRoles(space.roles) === null),
    )
  );
}
