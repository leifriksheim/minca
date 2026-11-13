/**
 * The hidden page where the node runs, for as long as Chrome does.
 *
 * It starts an app's node from the stored grant: it holds the account key
 * and the keys of the account's spaces, and a note to write records with. It
 * writes into the pod when Chrome allows it, and reports how things are to
 * the other pages and the badge.
 */
import { createDirectoryBlobStore, indexedDBStores, type BlobStore, type P2PNode } from '@minca/core';
import {
  appKey,
  deleteBrowserData,
  forgetAppKey,
  grantExpired,
  startConnectedNode,
  watchGrant,
  type Grant,
} from '@minca/core/session';
import { forgetDataFolder, queryFolderPermission, recallDataFolder } from '@minca/core/storage';
import { watchNotifications } from '@minca/std';
import { createNotifier } from '@minca/app-shared/notify';
import {
  BUILT_IN_RELAYS,
  daysLeft,
  forgetGrant,
  forgetPickedPod,
  KEY_NAME,
  loadGrant,
  loadPickedPod,
  loadRemoved,
  loadWarnedExpiry,
  RENEW_WITHIN_DAYS,
  saveWarnedExpiry,
  setRemoved,
  storePrefix,
  type ExtensionStatus,
  type Request,
  type StatusChanged,
  type WorkerMessage,
} from './shared';

const NOT_PICKED: ExtensionStatus['pod'] = { state: 'not-picked', folder: null };
const WELCOME = chrome.runtime.getURL('welcome.html');

let node: P2PNode | null = null;
let stopWatching: (() => void) | null = null;
let grant: Grant | null = null;
let status: ExtensionStatus = { state: 'starting', spaces: [], pod: NOT_PICKED };
/** Bumped by every (re)start, so a slow one that was overtaken stops */
let generation = 0;

function set(next: ExtensionStatus): void {
  status = next;
  const changed: StatusChanged = { to: 'pages', type: 'status', status };
  const badge: WorkerMessage = { to: 'worker', type: 'badge', status };
  // Nobody listening is fine: no page open, or the worker asleep.
  chrome.runtime.sendMessage(changed).catch(() => {});
  chrome.runtime.sendMessage(badge).catch(() => {});
}

const show = (shown: WorkerMessage & { type: 'notify' }) =>
  void chrome.runtime.sendMessage(shown satisfies WorkerMessage).catch(() => {});

// What the account asked to hear about, a burst in a space at a time, for the worker to show.
const notifier = createNotifier({ show: (shown) => show({ to: 'worker', type: 'notify', shown }) });

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSoon(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 250);
}

/** The spaces it keeps syncing: a node syncs a space only while something holds it */
const heldSpaces = new Set<string>();

async function refresh(): Promise<void> {
  const running = node;
  if (!running) return;
  const spaces = await Promise.all(
    (await running.spaces.list()).map(async ({ id, name }) => {
      if (!heldSpaces.has(id)) {
        await running.spaces.hold(id);
        heldSpaces.add(id);
      }
      const { connection, peers } = await running.spaces.status(id);
      return { id, name, connection, peers: peers.length };
    }),
  ).catch(() => status.spaces);
  if (running === node) set({ ...status, state: 'running', spaces });
}

async function stop(): Promise<void> {
  stopWatching?.();
  stopWatching = null;
  heldSpaces.clear();
  const running = node;
  node = null;
  await running?.close().catch(() => {});
}

/**
 * How the pod is doing, and where to write the account's spaces in it when
 * Chrome lets this extension. A folder picked in the welcome tab is
 * remembered; after a restart Chrome may want a click before it can be
 * written again, and then the pod waits: the node's own copy goes on, and
 * the pod catches up as soon as it is allowed.
 */
async function podNow(): Promise<{
  readonly pod: ExtensionStatus['pod'];
  readonly segments: BlobStore | null;
}> {
  const picked = await loadPickedPod();
  const handle = picked && (await recallDataFolder());
  if (!picked || !handle) return { pod: NOT_PICKED, segments: null };
  const allowed = (await queryFolderPermission(handle).catch(() => 'denied')) === 'granted';
  if (!allowed) return { pod: { state: 'needs-permission', folder: picked.folder }, segments: null };
  return {
    pod: { state: 'writing', folder: picked.folder },
    // Its spaces only: the registry beside them is sealed under a key no app is given.
    segments: createDirectoryBlobStore(handle, `${picked.dataPath}/spaces`),
  };
}

async function start(): Promise<void> {
  const mine = ++generation;
  await stop();
  grant = await loadGrant();
  if (mine !== generation) return;
  if (!grant) {
    set({ state: 'not-connected', removed: await loadRemoved(), spaces: [], pod: NOT_PICKED });
    return;
  }
  const { pod, segments } = await podNow();
  const connected = {
    account: { name: grant.name, did: grant.did, home: grant.home },
    expiresAt: grant.expiresAt,
    spaces: [],
    pod,
  };
  if (grantExpired(grant)) return set({ state: 'expired', ...connected });

  set({ state: 'starting', ...connected });
  try {
    const started = await startConnectedNode({
      grant,
      key: await appKey(KEY_NAME),
      network: { relays: [...BUILT_IN_RELAYS] },
      // It keeps every space whole: it is there for the account's other devices to sync with.
      cache: false,
      ...(segments
        ? { stores: Object.assign(indexedDBStores(storePrefix(grant.did)), { folder: segments }) }
        : {}),
    });
    if (mine !== generation) return void (await started.close());
    node = started;
    watch(started, grant);
    await warnBeforeExpiry();
    await refresh();
  } catch (error) {
    if (mine === generation)
      set({ ...status, state: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

function watch(started: P2PNode, under: Grant): void {
  const unwatchGrant = watchGrant(started, under, {
    onExpired: () => {
      show({
        to: 'worker',
        type: 'notify',
        shown: {
          title: 'Minca stopped syncing',
          body: 'Its connection to your account ran out. Connect it again.',
          open: WELCOME,
        },
      });
      void start();
    },
    onRevoked: () => void forget({ byAccount: true }),
  });
  const stopNotifying = watchNotifications(started, {
    // Every app's, and the person's own: it speaks for each while no tab has it open.
    origin: null,
    onNotify: ({ automation, record }) =>
      void started.spaces
        .get(record.space)
        .then((space) =>
          notifier.woke({
            space: space?.name ?? '',
            collection: record.collection,
            at: record.createdAt,
            ...(automation.open ? { open: automation.open } : {}),
          }),
        )
        .catch(() => {}),
  });
  const unsubscribe = started.subscribe((event) => {
    if (event.type === 'status' || event.type === 'spaces') refreshSoon();
  });
  stopWatching = () => {
    unwatchGrant();
    stopNotifying();
    unsubscribe();
  };
}

/** Says once, with a while still to go, that the connection is about to run out */
async function warnBeforeExpiry(): Promise<void> {
  if (!node || !grant) return;
  const left = daysLeft(grant.expiresAt);
  if (left > RENEW_WITHIN_DAYS || (await loadWarnedExpiry()) === grant.expiresAt) return;
  await saveWarnedExpiry(grant.expiresAt);
  show({
    to: 'worker',
    type: 'notify',
    shown: {
      title: 'Connect Minca again soon',
      body:
        left < 1
          ? 'Its connection to your account runs out today.'
          : `Its connection to your account runs out in ${left} day${left === 1 ? '' : 's'}.`,
      open: WELCOME,
    },
  });
  set({ ...status });
}

/** Starts again when Chrome's answer about the folder changed: a node is given its stores once */
async function followPodPermission(): Promise<void> {
  if (!node) return;
  const { state } = (await podNow()).pod;
  if (state !== status.pod.state) await start();
}

/**
 * Starts again with nothing remembered of what the pod holds: what it wrote
 * into the folder picked before is not in this one.
 */
async function startOnPickedPod(): Promise<void> {
  generation++;
  await stop();
  if (grant) await deleteBrowserData(`${storePrefix(grant.did)}:folder:`);
  await start();
}

/**
 * Forgets everything: the node's copy, its key, the grant, the folder.
 * @param options.byAccount The account disconnected it, rather than the person here
 */
async function forget(options: { byAccount: boolean }): Promise<void> {
  generation++;
  const did = grant?.did;
  await stop();
  if (did) await deleteBrowserData(storePrefix(did));
  await forgetDataFolder();
  await forgetPickedPod();
  await forgetGrant();
  await forgetAppKey(KEY_NAME);
  await setRemoved(options.byAccount);
  grant = null;
  set({ state: 'not-connected', removed: options.byAccount, spaces: [], pod: NOT_PICKED });
}

chrome.runtime.onMessage.addListener((message: Request, _sender, respond) => {
  if (message?.to !== 'offscreen') return false;
  const answer = () => respond(status);
  if (message.type === 'status') answer();
  else if (message.type === 'reload') void start().then(answer, answer);
  else if (message.type === 'pod-picked') void startOnPickedPod().then(answer, answer);
  else if (message.type === 'disconnect') void forget({ byAccount: false }).then(answer, answer);
  return message.type !== 'status';
});

// A folder's permission can come or go while running (the welcome tab asked,
// or the person revoked it in Chrome's settings), and a grant's end comes
// nearer; look again now and then.
setInterval(() => {
  void followPodPermission().catch(() => {});
  void warnBeforeExpiry().catch(() => {});
}, 60_000);

void start();
