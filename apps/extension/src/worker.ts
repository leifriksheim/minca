/**
 * The service worker. Chrome stops it after about thirty quiet seconds, so the
 * carrier cannot live here; its one job is to keep the offscreen page — where
 * the carrier does live — in existence, to show how it is doing on the
 * toolbar button, and to show what the account asked to hear about while no
 * tab has the app open.
 *
 * It makes the page when Chrome starts, when the extension is installed or
 * updated, when any page asks, and on a one-minute alarm in case Chrome closed
 * it for any reason.
 */
import { state } from '@minca/ui/tokens';
import type { Shown } from '@minca/app-shared/notify';
import type { CarrierStatus, Request, WorkerMessage } from './shared';

const OFFSCREEN = 'offscreen.html';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length > 0) return;
  // Two callers at once must not both create it: Chrome allows one.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification:
        'Runs a peer that keeps your Minca spaces synced with your other devices over WebRTC while the browser is open.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function showBadge(status: CarrierStatus): Promise<void> {
  const unread = Object.keys(await chrome.notifications.getAll()).length;
  const podNeedsYou = status.pod.state === 'not-picked' || status.pod.state === 'needs-permission';
  let text = '';
  let color: string = state.ink;
  let title = 'Minca';
  if (status.state === 'not-connected') {
    title = status.removed ? 'Minca — disconnected by your account' : 'Minca — not connected yet';
  } else if (status.state === 'error') {
    text = '!';
    color = state.danger;
    title = `Minca — ${status.error ?? 'something went wrong'}`;
  } else if (podNeedsYou) {
    text = '!';
    color = state.warn;
    title = 'Minca — your pod needs a click to keep syncing';
  } else if (status.state === 'running') {
    // How many notifications wait, or a small green mark: carrying.
    text = unread > 0 ? String(unread) : ' ';
    color = unread > 0 ? state.danger : state.good;
    const carried = status.spaces.filter((space) => !space.carry).length;
    title = `Minca — keeping ${carried} space${carried === 1 ? '' : 's'} online${unread > 0 ? `, ${unread} new` : ''}`;
  }
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setTitle({ title });
}

/** The badge again, from the status the offscreen page holds */
const redraw = () =>
  chrome.runtime.sendMessage({ to: 'offscreen', type: 'status' } satisfies Request).then(showBadge, () => {});

// ─── Notifications ──────────────────────────────────────────────────────
//
// A notification's id starts with the app it leads to, so a click knows where
// to go and opening the app clears what it would show itself, with nothing
// kept here for Chrome to lose when it stops the worker.

const idFor = (open: string) => `${open} ${crypto.randomUUID()}`;
const appOf = (id: string) => id.split(' ')[0] ?? '';

function originOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return null;
  }
}

/** Whether a tab shows the app already: then it notifies for itself */
async function appIsOpen(open: string): Promise<boolean> {
  const origin = originOf(open);
  if (!origin) return false;
  return (await chrome.tabs.query({})).some((tab) => originOf(tab.url) === origin);
}

async function notify(shown: Shown): Promise<void> {
  if (shown.open && (await appIsOpen(shown.open))) return;
  await chrome.notifications.create(idFor(shown.open ?? ''), {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: shown.title,
    message: shown.body,
  });
  await redraw();
}

/** A tab opened the app: it shows what these said, so they go */
async function clearFor(url: string): Promise<void> {
  const origin = originOf(url);
  if (!origin) return;
  const ids = Object.keys(await chrome.notifications.getAll()).filter((id) => originOf(appOf(id)) === origin);
  if (ids.length === 0) return;
  await Promise.all(ids.map((id) => chrome.notifications.clear(id)));
  await redraw();
}

chrome.notifications.onClicked.addListener((id) => {
  const app = appOf(id);
  if (app) void chrome.tabs.create({ url: app });
  void chrome.notifications.clear(id).then(redraw);
});
chrome.notifications.onClosed.addListener(() => void redraw());
chrome.tabs.onUpdated.addListener((_tab, change) => {
  if (change.url) void clearFor(change.url);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  void ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => void ensureOffscreen());

void chrome.alarms.create('keep-carrying', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-carrying') void ensureOffscreen();
});

chrome.runtime.onMessage.addListener((message: WorkerMessage, _sender, respond) => {
  if (message?.to !== 'worker') return false;
  if (message.type === 'badge') {
    void showBadge(message.status);
    return false;
  }
  if (message.type === 'notify') {
    void notify(message.shown);
    return false;
  }
  ensureOffscreen().then(
    () => respond(true),
    () => respond(false),
  );
  return true; // answering later
});

void ensureOffscreen();
