/**
 * The little the two visible pages share: building elements, and drawing the
 * spaces and the pod the same way in both.
 */
import { ensureFolderPermission, recallDataFolder } from '@minca/core/storage';
import { avatarElement } from '@minca/ui/avatar';
import { MARK_BANDS, MARK_VIEWBOX } from '@minca/app-shared/mark';
import type { ExtensionStatus, PodState } from './shared';

type Child = Node | string | null | false | undefined;
type Attribute = string | number | boolean | null | undefined | ((event: Event) => void);

/** An element, with attributes (`on*` for listeners) and children */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, Attribute> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function')
      element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'class') element.className = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children)
    if (child !== null && child !== false && child !== undefined) element.append(child);
  return element;
}

/** The wordmark, as on the site */
export function mark(): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', MARK_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  // The bands' colours come from the tokens, by class, in styles.css.
  for (const [index, { d }] of MARK_BANDS.entries()) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `band-${index + 1}`);
    svg.append(path);
  }
  return h('div', { class: 'mark' }, svg, 'minca');
}

/** Whose spaces these are, and which home connected them — the thing to check when something looks wrong */
export function accountLine(account: NonNullable<ExtensionStatus['account']>, action?: Node): HTMLElement {
  return h(
    'div',
    { class: 'account' },
    avatarElement(account.did, 32),
    h(
      'div',
      { class: 'who' },
      h('strong', {}, account.name),
      h('small', {}, `through ${new URL(account.home).host}`),
    ),
    action ?? null,
  );
}

/** The spaces kept online, with whether each is reaching anyone */
export function spaceList(status: ExtensionStatus): HTMLElement {
  const { spaces } = status;
  if (spaces.length === 0) {
    return h(
      'small',
      {},
      status.state === 'starting'
        ? 'Starting…'
        : status.state === 'expired'
          ? 'Nothing is syncing: its connection ran out.'
          : 'Waiting to hear from one of your devices. Open Minca on any of them, and your spaces arrive here.',
    );
  }
  return h(
    'ul',
    { class: 'spaces' },
    ...spaces.map((space) =>
      h(
        'li',
        {},
        h(
          'span',
          { class: 'name' },
          h('span', {
            class: `dot ${space.connection === 'connected' ? 'good' : space.connection === 'error' ? 'bad' : ''}`,
          }),
          space.name,
        ),
        h(
          'span',
          { class: 'meta' },
          space.peers === 0
            ? 'nobody else online'
            : `with ${space.peers} other${space.peers === 1 ? '' : 's'}`,
        ),
      ),
    ),
  );
}

/** One line on how many spaces are kept online */
export function summary(status: ExtensionStatus): string {
  const { spaces } = status;
  if (status.state === 'expired') return 'Its connection to your account ran out.';
  const count = `${spaces.length} space${spaces.length === 1 ? '' : 's'}`;
  return spaces.some((space) => space.peers > 0)
    ? `Keeping ${count} online.`
    : `Keeping ${count} online. Nobody else is online right now.`;
}

/** How the pod is doing, in a line both pages show the same */
export function podLine(state: Exclude<PodState, 'not-picked'>, folder: string | null): HTMLElement {
  const said =
    state === 'writing'
      ? `Up to date: everything that arrives is written into “${folder}”.`
      : `Chrome wants a click before this writes to “${folder}” again. Until then, your pod catches up later.`;
  return h('small', {}, h('span', { class: `dot ${state === 'writing' ? 'good' : 'warn'}` }), said);
}

/**
 * Asks Chrome to let the extension write the pod again. Needs a click: call
 * it from one.
 * @returns Whether it may
 */
export async function resumePod(): Promise<boolean> {
  const handle = await recallDataFolder();
  return handle ? ensureFolderPermission(handle, { request: true }) : false;
}
