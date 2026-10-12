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
import { checkStartingRoles } from '../space/space-access.js';
import { parseSpaceInvite } from '../space/space-manager.js';
import { checkProposal, MAX_PROPOSALS, type NotifyProposal } from '../space/notify.js';
import { defaultStorage, guardedStorage, type KeyValueStore } from './stay-signed-in.js';
import { isObject } from '../utils/guards.js';

/** Messages between an app and the home it opened */
const HELLO = 'weave:hello';
const REQUEST = 'weave:request';
const GRANT = 'weave:grant';
const DENIED = 'weave:denied';

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
   * `code`: the key is not the app's own but a program's, which reached the
   * app over a connect code (`connect-code.ts`). The home keeps its
   * connection by its key, apart from the app's own. Absent: the app's own key.
   */
  readonly via?: 'code';
  /** How many days the note should last, 1–365. The home decides; default 7. */
  readonly days?: number;
}

/**
 * What an app already connected to a home asks for when the person wants to
 * be notified: subscriptions, and nothing else. Never part of connecting — a
 * person signing in has asked for nothing yet. The home knows the app by the
 * origin the browser reports, and refuses one it has no connection for, a
 * carrier's and a program's connected by code.
 */
export interface ProposeRequest {
  readonly v: 1;
  readonly kind: 'propose';
  /** What it calls itself. Shown, never trusted. */
  readonly name?: string;
  /** 1 to 8 subscriptions to offer the person */
  readonly notify: ReadonlyArray<NotifyProposal>;
}

/** What the home answers a {@link ProposeRequest} with, once the person decided */
export interface Proposed {
  readonly v: 1;
  readonly kind: 'proposed';
  /** The subscriptions added or found, by the person's yes: none when they kept none */
  readonly notify: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /**
   * For an app given the whole account: every version of those subscriptions,
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
 * `weave.example.com` → `https://weave.example.com/connect`. Plain `http` only
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
const KEY_PROOF = 'weave/connect-key/v1';

/**
 * What a key agrees to in a connect request: how it reached the app, how much
 * it asks for, and, for a program's key handed over a code, the app it went
 * through.
 */
export type KeyTerms =
  /** The app's own key */
  | { readonly via: 'popup'; readonly recordsOnly: boolean }
  /** A program's key, handed to the app at `origin` over a connect code */
  | { readonly via: 'code'; readonly recordsOnly: boolean; readonly origin: string };

/**
 * The statement, terms included: a proof a program hands an app over a code
 * can't ask for the app's own connection, nor for more than records when it
 * asked for records only, nor be used from another app's origin.
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

const KEY_DB = 'weave-app-key';

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
  /** The home's connect page, e.g. `https://weave.example/connect` */
  readonly home: string;
  /** What to ask for; `audience`, `proof` and `via` are filled in */
  readonly request: Omit<ConnectRequest, 'v' | 'audience' | 'proof' | 'via'>;
  /** The key to ask for. Default: {@link appKey} under `keyName`. */
  readonly key?: AppKey;
  /** Which of this app's keys to use when `key` is not given. Default `default`. */
  readonly keyName?: string;
  /**
   * Ask for a note made out to this key instead of one of the app's own: a
   * program's that reached the app over a connect code (`offerConnectCode`).
   */
  readonly audience?: string;
  /** With `audience`: that key's {@link keyProof} with `via: code` and this app's origin, which only its holder can make */
  readonly audienceProof?: string;
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
  let audience: string;
  let proof: string;
  const byCode = options.audience !== undefined;
  if (options.audience !== undefined) {
    if (!options.audienceProof) throw new Error('Asking for another key needs its proof (keyProof).');
    audience = options.audience;
    proof = options.audienceProof;
  } else {
    const key = options.key ?? (await appKey(options.keyName));
    audience = key.did;
    proof = await keyProof(key, { via: 'popup', recordsOnly: options.request.recordsOnly === true });
  }
  const grant = await askHome<Grant>(
    popup,
    homeUrl.origin,
    { v: 1, audience, proof, ...options.request, ...(byCode ? { via: 'code' as const } : {}) },
    options.timeoutMs,
  );
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
  const request: ConnectRequest = {
    v: 1,
    audience: options.key.did,
    proof: await keyProof(options.key),
    access: 'carry',
    ...(options.name ? { name: options.name } : {}),
  };
  const grant = await askHome<CarryGrant>(popup, homeUrl.origin, request, options.timeoutMs);
  checkCarryGrant(grant);
  return { ...grant, home: homeUrl.href };
}

/**
 * Offers the person subscriptions, from an app already connected to their
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
  readonly notify: ReadonlyArray<NotifyProposal>;
  readonly name?: string;
  readonly timeoutMs?: number;
}): Promise<Proposed> {
  if (options.notify.length === 0 || options.notify.length > MAX_PROPOSALS)
    throw new Error(`Propose 1 to ${MAX_PROPOSALS} subscriptions.`);
  const homeUrl = new URL(options.home, globalThis.location.href);
  const popup = openHome(homeUrl);
  const request: ProposeRequest = {
    v: 1,
    kind: 'propose',
    ...(options.name ? { name: options.name } : {}),
    notify: options.notify,
  };
  const answer = await askHome<Proposed | null>(popup, homeUrl.origin, request, options.timeoutMs);
  if (answer?.kind !== 'proposed' || !Array.isArray(answer.notify))
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
    invite.space.creator !== grant.did ||
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
  const popup = globalThis.open(homeUrl.href, 'weave-home', 'popup,width=460,height=720');
  if (!popup) throw new Error('The browser blocked the window. Allow pop-ups for this site and try again.');
  return popup;
}

/** Sends the request once the home says hello, and waits for its answer, which the caller checks. */
function askHome<T>(
  popup: Window,
  homeOrigin: string,
  request: ConnectRequest | ProposeRequest,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = (finish: () => void) => {
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearInterval(watch);
      globalThis.clearTimeout(timer);
      finish();
    };
    const onMessage = (event: MessageEvent) => {
      // Only the popup we opened, at the address we opened it on.
      if (event.source !== popup || event.origin !== homeOrigin) return;
      const data: unknown = event.data;
      if (!isObject(data)) return;
      if (data.type === HELLO) popup.postMessage({ type: REQUEST, request }, homeOrigin);
      else if (data.type === GRANT && data.grant)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkGrant, checkCarryGrant and proposeToHome check it
        done(() => resolve(data.grant as T));
      else if (data.type === DENIED)
        done(() =>
          reject(new Error(typeof data.reason === 'string' ? data.reason : 'Access was not given.')),
        );
    };
    const watch = globalThis.setInterval(() => {
      if (popup.closed) done(() => reject(new Error('The window was closed before access was given.')));
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

/** A signer that answers with the note the home gave — the app holds nothing else. */
export function grantSigner(grant: Grant): RootSigner {
  return {
    did: grant.did,
    custody: 'remote',
    async delegate() {
      if (grant.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new Error('Access has run out. Connect to your account home again.');
      }
      return grant.note;
    },
  };
}

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
  // The home's relays as well as the app's, so the two always share one.
  const relays = [...new Set([...(params.network?.relays ?? []), ...(params.grant.relays ?? [])])];
  const network = params.network || relays.length ? { ...params.network, relays } : undefined;
  const node = await startPageNode(
    {
      signer: grantSigner(params.grant),
      sessionKey: key.keys,
      stores: { indexedDB: `weave-app:${params.grant.did}` },
      ...(network ? { network } : {}),
      ...(params.cache === false ? {} : { cache: params.cache ?? {} }),
      ...(params.grant.accountKey ? { accountKey: base64UrlDecode(params.grant.accountKey) } : {}),
      ...(params.grant.contactKey ? { contactKey: base64UrlDecode(params.grant.contactKey) } : {}),
      ...(params.grant.contactsSpace ? { contactsSpace: params.grant.contactsSpace } : {}),
    },
    params,
  );
  const held = new Set((await node.spaces.list()).map((space) => space.id));
  for (const space of params.grant.spaces) {
    if (!held.has(space.id))
      await node.spaces.join(
        space.invite,
        space.memberKey ? { memberKey: base64UrlDecode(space.memberKey) } : {},
      );
  }
  return node;
}

/** Where an app keeps its grant between visits */
export function grantStore(storage: KeyValueStore | null = defaultStorage(), key = 'weave.grant') {
  const kept = guardedStorage(storage);
  return {
    load(): Grant | null {
      const grant = kept.read<Grant>(key);
      // One kept in an older format holds a note no peer reads now: connecting again replaces it.
      return grant && grant.v === GRANT_VERSION && grant.expiresAt > Math.floor(Date.now() / 1000)
        ? grant
        : null;
    },
    save: (grant: Grant): void => kept.write(key, grant),
    forget: (): void => kept.write(key, null),
  };
}

// ─── The home's side ─────────────────────────────────────────────────

/** A request as the home received it */
export interface IncomingRequest {
  readonly request: ConnectRequest | ProposeRequest;
  /** Where it came from, as the browser reports it — the only name to trust */
  readonly origin: string;
  /** Sends the answer back to that origin, and closes the window */
  approve(answer: Omit<Grant, 'home'> | Omit<CarryGrant, 'home'> | Proposed): void;
  /** Says no, and closes the window */
  deny(reason?: string): void;
}

/**
 * Waits for the app that opened this page to say what it wants.
 * @returns The request, or null when this page was not opened by an app
 */
export function receiveConnectRequest(timeoutMs = 10_000): Promise<IncomingRequest | null> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- lib.dom has it as any, and an opener on another origin is no instanceof Window here
  const opener = globalThis.opener as Window | null;
  if (!opener) return Promise.resolve(null);

  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const data: unknown = event.data;
      if (!isObject(data) || data.type !== REQUEST) return;
      globalThis.removeEventListener('message', onMessage);
      globalThis.clearTimeout(timer);

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
      const reply = (message: unknown) => {
        opener.postMessage(message, origin);
        // A moment's grace, so the answer is delivered before the window goes.
        globalThis.setTimeout(() => globalThis.close(), 100);
      };
      resolve({
        request: data.request,
        origin,
        approve: (answer) => reply({ type: GRANT, grant: answer }),
        deny: (reason) => reply({ type: DENIED, reason: reason ?? 'Access was not given.' }),
      });
    };
    const timer = globalThis.setTimeout(() => {
      globalThis.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);
    globalThis.addEventListener('message', onMessage);
    // Nothing secret in a hello, so any origin may hear it; the request that
    // answers it is what names the app.
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
const PROPOSE_FIELDS = new Set(['v', 'kind', 'name', 'notify']);

const onlyFields = (value: Record<string, unknown>, fields: ReadonlySet<string>): boolean =>
  Object.keys(value).every((field) => fields.has(field));

function isRequest(value: unknown, origin: string): value is ConnectRequest | ProposeRequest {
  if (!isObject(value)) return false;
  const proposal = value;
  if (proposal.kind !== undefined) {
    return (
      onlyFields(proposal, PROPOSE_FIELDS) &&
      proposal.v === 1 &&
      proposal.kind === 'propose' &&
      (proposal.name === undefined || (typeof proposal.name === 'string' && proposal.name.length <= 80)) &&
      Array.isArray(proposal.notify) &&
      proposal.notify.length > 0 &&
      isProposals(proposal.notify, origin)
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
    (request.via === undefined || (request.via === 'code' && request.access !== 'carry')) &&
    // Records only: in spaces that exist, none made for it, no contacts and no carrying.
    (request.recordsOnly === undefined ||
      request.recordsOnly === false ||
      (request.recordsOnly === true &&
        request.access !== 'carry' &&
        request.create === undefined &&
        !request.contacts))
  );
}

/** Subscriptions an app proposes: few, each one it could offer, each click leading back to it */
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
        (space.roles === undefined ||
          checkStartingRoles(
            space.roles,
            space.creatorRole ?? [...space.roles].sort((a, b) => b.rank - a.rank)[0]?.name,
          ) === null),
    )
  );
}
