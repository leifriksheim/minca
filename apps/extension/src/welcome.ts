/**
 * The extension's own tab: connecting to the account home, picking the pod,
 * and seeing what is kept online. Opened on install, and from the toolbar popup.
 *
 * Connecting happens here rather than in the popup because the popup closes
 * the moment the home's window takes focus, and the home's answer would have
 * nowhere to arrive.
 */
import {
  connectToHome,
  homeAddress,
  listAccounts,
  pickPod,
  rememberPod,
  type Grant,
} from '@minca/core/session';
import {
  ask,
  CONNECT_REQUEST,
  daysLeft,
  DEFAULT_HOME,
  KEY_NAME,
  loadGrant,
  RENEW_WITHIN_DAYS,
  saveGrant,
  savePickedPod,
  setRemoved,
  type ExtensionStatus,
  type StatusChanged,
} from './shared';
import { accountLine, h, mark, podLine, resumePod, spaceList, summary } from './ui';

const app = document.getElementById('app')!;
let status: ExtensionStatus | null = null;
let grant: Grant | null = null;
let error: string | null = null;
let busy = false;

function render(): void {
  const view = status?.state === 'not-connected' || !grant ? connectView() : connectedView();
  app.replaceChildren(mark(), ...view.filter((node): node is Node => node !== null));
}

async function update(next?: ExtensionStatus): Promise<void> {
  status = next ?? (await ask({ to: 'offscreen', type: 'status' }));
  grant = await loadGrant();
  render();
}

async function run(task: () => Promise<void>): Promise<void> {
  busy = true;
  error = null;
  render();
  try {
    await task();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    await update();
  }
}

/** Asks a home with this extension's key: the one it has, so connecting again renews it */
const askHome = (home: string) => connectToHome({ home, request: CONNECT_REQUEST, keyName: KEY_NAME });

// ─── Not connected ────────────────────────────────────────────────────

function connectView(): Array<Node | null> {
  const input = h('input', {
    id: 'home',
    value: new URL(DEFAULT_HOME).host,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const connect = () =>
    run(async () => {
      await saveGrant(await askHome(homeAddress(input.value)));
      await setRemoved(false);
      await ask({ to: 'offscreen', type: 'reload' });
    });

  return [
    status?.removed
      ? h('aside', {}, 'Your account disconnected this extension, and it forgot everything it held.')
      : null,
    h('h1', {}, 'Keep your spaces online'),
    h(
      'p',
      {},
      'While Chrome is open, this keeps your Minca spaces in sync with your other devices and the people you share with — even with no app open.',
    ),
    h(
      'section',
      {},
      h('label', { for: 'home' }, 'Your account home'),
      input,
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { 'data-intent': 'primary', class: 'wide', disabled: busy, onClick: () => void connect() },
          busy ? 'Waiting for your account home…' : 'Connect',
        ),
      ),
      h('p', {}, 'Your account home opens in a new window. Sign in there, and allow it.'),
      error ? h('p', { role: 'alert' }, error) : null,
    ),
    h(
      'small',
      {},
      'It connects like an app you use for your whole account: this browser profile holds the keys to your spaces, and can write records in them as you. It never gets your password. Its connection lasts up to a year, then it asks you again.',
    ),
  ];
}

// ─── Connected ────────────────────────────────────────────────────────

function connectedView(): Array<Node | null> {
  const accountHome = grant ? new URL(grant.home).origin : null;
  const account = status?.account ?? (grant ? { name: grant.name, did: grant.did, home: grant.home } : null);
  return [
    h('h1', {}, 'Keeping your spaces online'),
    h('p', {}, 'While Chrome is open, your spaces stay in sync — even with no app open.'),
    account
      ? h(
          'section',
          {},
          accountLine(
            account,
            h(
              'button',
              {
                'data-intent': runsOutSoon() ? 'primary' : undefined,
                disabled: busy,
                onClick: () => void connectAgain(),
              },
              busy ? 'Waiting…' : 'Connect again',
            ),
          ),
          h('p', {}, connectionLine()),
        )
      : null,
    status?.state === 'error'
      ? h(
          'aside',
          {},
          `Something went wrong: ${status.error ?? 'unknown'}. It will try again when Chrome restarts.`,
        )
      : null,
    h(
      'section',
      {},
      h('h2', {}, 'Spaces'),
      status ? h('small', {}, summary(status)) : null,
      status ? spaceList(status) : null,
    ),
    grant ? podSection(grant) : null,
    h(
      'section',
      {},
      h('h2', {}, 'Disconnect'),
      h('small', {}, 'Forgets everything this extension holds. Your spaces stay on your devices.'),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { 'data-intent': 'danger', disabled: busy, onClick: () => void disconnect() },
          'Disconnect',
        ),
        accountHome ? h('a', { href: accountHome, target: '_blank' }, 'Your account home') : null,
      ),
    ),
    error ? h('p', { role: 'alert' }, error) : null,
  ];
}

function podSection(connected: Grant): HTMLElement {
  const pod = status?.pod ?? { state: 'not-picked', folder: null };
  const choose = () =>
    run(async () => {
      const picked = await pickPod();
      const account = (await listAccounts(picked)).find((kept) => kept.did === connected.did);
      if (!account)
        throw new Error(
          'That folder doesn’t hold this account. Choose the folder your account home keeps it in.',
        );
      await rememberPod(picked);
      await savePickedPod({ dataPath: account.dataPath, folder: picked.directory?.name ?? 'your pod' });
      await ask({ to: 'offscreen', type: 'reload' });
    });
  const resume = () =>
    run(async () => {
      if (!(await resumePod()))
        throw new Error('Chrome did not allow it. Try again, or choose the folder again.');
      await ask({ to: 'offscreen', type: 'reload' });
    });

  const button = (label: string, onClick: () => Promise<void>, quiet = false) =>
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { 'data-intent': quiet ? undefined : 'primary', disabled: busy, onClick: () => void onClick() },
        label,
      ),
    );
  if (pod.state === 'not-picked')
    return h(
      'section',
      {},
      h('h2', {}, 'A folder'),
      h(
        'small',
        {},
        'If your account home keeps your account in a folder, choose that folder here. This then keeps it up to date while Chrome is open, so it holds everything even when your account home is closed.',
      ),
      button('Choose your pod folder', choose, true),
    );
  return h(
    'section',
    {},
    h('h2', {}, 'Your pod'),
    podLine(pod.state, pod.folder),
    ...(pod.state === 'writing'
      ? [button('Choose another folder', choose, true)]
      : [
          h(
            'aside',
            {},
            'When Chrome asks, choose ',
            h('strong', {}, 'Allow on every visit'),
            '. Then it keeps writing to your pod without asking again.',
          ),
          button('Resume pod sync', resume),
        ]),
  );
}

const runsOutSoon = () =>
  status?.state === 'expired' || (grant !== null && daysLeft(grant.expiresAt) <= RENEW_WITHIN_DAYS);

/** How long its connection has left, and what connecting again is for */
function connectionLine(): string {
  if (!grant) return '';
  const left = daysLeft(grant.expiresAt);
  if (status?.state === 'expired' || left < 0)
    return 'Its connection to your account ran out, so nothing is syncing. Connect again to go on.';
  const lasts = left < 1 ? 'runs out today' : `lasts ${left} more day${left === 1 ? '' : 's'}`;
  return `Its connection to your account ${lasts}. Connecting again renews it. To use another account here, disconnect first.`;
}

/** Renews the connection, with the key it has. Another account needs a key of its own: disconnect first. */
async function connectAgain(): Promise<void> {
  const connected = grant;
  if (!connected) return;
  await run(async () => {
    const received = await askHome(connected.home);
    if (received.did !== connected.did)
      throw new Error(
        `Your account home answered as ${received.name}, and this is connected as ${connected.name}. To use ${received.name} here, disconnect first.`,
      );
    await saveGrant(received);
    await ask({ to: 'offscreen', type: 'reload' });
  });
}

async function disconnect(): Promise<void> {
  if (
    !confirm(
      'Forget everything this extension holds? Your spaces stay on your devices. To stop your account sending it anything, also disconnect it in your account home.',
    )
  )
    return;
  await run(async () => {
    await ask({ to: 'offscreen', type: 'disconnect' });
  });
}

chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message?.to === 'pages' && message.type === 'status' && !busy) void update(message.status);
  return false;
});

void update();
