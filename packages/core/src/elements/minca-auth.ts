/**
 * @module elements/minca-auth
 * `<minca-auth>`: the whole sign-in flow as one element.
 *
 * ```html
 * <minca-auth app-name="Todo" relays="wss://relay.example"></minca-auth>
 * <script type="module">
 *   import '@minca/core/elements';
 *   document.querySelector('minca-auth').addEventListener('minca-session', (event) => {
 *     const session = event.detail.session;   // null when signed out
 *     if (session) start(session.node);
 *   });
 * </script>
 * ```
 *
 * Or hand it a flow you made yourself: `element.auth = createMincaAuth({ … })`.
 * It draws into its light DOM, not a shadow root, because password managers
 * fill forms there far more reliably; its styles are scoped to the element.
 */
import {
  createMincaAuth,
  type AccountEntry,
  type AuthError,
  type AuthState,
  type MincaAuth,
  type MincaSession,
} from '../session/auth.js';
import { accountCredentialName, offerToSave, recoveryKit } from '../session/credentials.js';
import { passwordStrength } from '../session/password-strength.js';
import type { PairingStage } from '../session/pairing.js';
import type { AccountSummary } from '../identity/account-store.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { formatUsername, parseUsername, resolveUsername, usernameIdeas } from '../inbox/names.js';
import { adoptStyles, h, svg, type Child } from './dom.js';
import { AUTH_CSS } from './auth-styles.js';

/** What `minca-session` carries */
export interface MincaSessionEventDetail {
  readonly session: MincaSession | null;
}

/** Where a username on the create screen stands */
type NameState = 'empty' | 'checking' | 'free' | 'taken' | 'invalid';

/** Looks usernames up as they are typed */
const provider = createP256Provider();

// Where there is no DOM the module still loads; the element is only ever made where there is one.
const Base = globalThis.HTMLElement ?? class {};

/** The mark and the name, above every step */
function wordmark(): HTMLElement {
  return h(
    'div',
    { class: 'wa-wordmark' },
    svg(
      '<svg width="24" height="13" viewBox="0 0 24 13" aria-hidden="true"><path fill="#2340d6" d="M0.5 12.5A11.5 11.5 0 0 1 23.5 12.5H20.75A8.75 8.75 0 0 0 3.25 12.5Z"/><path fill="#ff6b4a" d="M3.25 12.5A8.75 8.75 0 0 1 20.75 12.5H18A6 6 0 0 0 6 12.5Z"/><path fill="#ffc46b" d="M6 12.5A6 6 0 0 1 18 12.5H15.25A3.25 3.25 0 0 0 8.75 12.5Z"/><path fill="#4e8f6c" d="M8.75 12.5A3.25 3.25 0 0 1 15.25 12.5Z"/></svg>',
    ),
    'minca',
  );
}

/** A small deterministic hash, enough to seed a 5×5 pattern and a hue. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/**
 * A visual fingerprint for an account, derived from its DID — the same
 * everywhere it appears, so a wrong account is obvious before its name is read.
 */
function avatar(did: string, size = 32): Element {
  const seed = hash(did);
  const hue = seed % 360;
  const cells: string[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (((seed >> (x * 5 + y)) & 1) === 0) continue;
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      if (x < 2) cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1"/>`);
    }
  }
  return svg(
    `<svg class="wa-avatar" width="${size}" height="${size}" viewBox="0 0 5 5" role="img" aria-label="Account avatar" style="background:hsl(${hue} 46% 92%)"><g fill="hsl(${hue} 62% 48%)">${cells.join('')}</g></svg>`,
  );
}

/** An explanation, folded away until asked for. */
function info(label: string, ...text: Child[]): HTMLElement {
  const popover = h('span', { class: 'wa-popover', role: 'note', hidden: true }, ...text);
  const button = h(
    'button',
    {
      type: 'button',
      class: 'wa-info-button',
      'aria-label': label,
      'aria-expanded': 'false',
      onclick: () => {
        popover.hidden = !popover.hidden;
        button.setAttribute('aria-expanded', String(!popover.hidden));
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Escape') popover.hidden = true;
      },
    },
    'i',
  );
  return h('span', { class: 'wa-info' }, button, popover);
}

function errorBox(error: AuthError | null): HTMLElement | null {
  if (!error) return null;
  return h(
    'div',
    { class: 'wa-error-box', role: 'alert' },
    h('p', { class: 'wa-error' }, error.message),
    error.hint ? h('p', { class: 'wa-small' }, error.hint) : null,
  );
}

function option(
  title: string,
  text: string,
  onclick: () => void,
  disabled: boolean,
  recommended = false,
): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'wa-option', onclick, disabled },
    h(
      'span',
      { class: 'wa-option-title' },
      title,
      recommended ? h('span', { class: 'wa-badge' }, 'Recommended') : null,
    ),
    h('span', { class: 'wa-option-text' }, text),
  );
}

function link(text: string, onclick: () => void, disabled = false): HTMLElement {
  return h('button', { type: 'button', class: 'wa-link', onclick, disabled }, text);
}

function links(...children: Child[]): HTMLElement {
  return h('div', { class: 'wa-links' }, ...children);
}

/** A step: the mark, its title, and what goes under it */
function card(title: string, ...body: Child[]): HTMLElement {
  return h('div', { class: 'wa-card' }, wordmark(), h('h1', { class: 'wa-title' }, title), ...body);
}

function subtitle(...text: Child[]): HTMLElement {
  return h('p', { class: 'wa-subtitle' }, ...text);
}

/** How the username asked for at sign-up is going, above the setup screens that follow */
function claimLine({ username: claim }: AuthState): HTMLElement | null {
  if (!claim) return null;
  const states = { claiming: 'checking', claimed: 'free', failed: 'taken' } as const;
  return h(
    'p',
    { class: 'wa-small', 'data-name': states[claim.status], 'aria-live': 'polite', style: 'margin:0 0 12px' },
    claim.status === 'claiming'
      ? `Getting ${claim.username} for you…`
      : claim.status === 'claimed'
        ? `${claim.username} is yours.`
        : `${claim.username} couldn't be yours: ${claim.error ?? 'the name service said no'}. Pick another in any app, under Contacts.`,
  );
}

/** A form that stays on the page when submitted */
function form(onSubmit: () => void, props: Record<string, unknown>, ...children: Child[]): HTMLElement {
  return h(
    'form',
    {
      class: 'wa-form',
      ...props,
      onsubmit: (event: Event) => {
        event.preventDefault();
        onSubmit();
      },
    },
    ...children,
  );
}

/** The step's one main button */
function button(label: string, onclick: () => void, disabled: boolean, key?: string): HTMLElement {
  return h('button', { type: 'button', class: 'wa-button', 'data-key': key, disabled, onclick }, label);
}

function submit(busy: boolean, label: string, busyLabel: string): HTMLElement {
  return h('button', { type: 'submit', class: 'wa-button', disabled: busy }, busy ? busyLabel : label);
}

/**
 * The username a password manager files a credential under: off-screen but
 * deliberately not `display: none`, which managers do not count as a username.
 */
function offscreenUsername(value: string, readonly: boolean): HTMLInputElement {
  return h('input', {
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    value,
    readonly,
    class: 'wa-offscreen',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
}

/** Hands the page a text file to save. */
function download({ filename, text }: { filename: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = h('a', { href: url, download: filename, style: 'display:none' });
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** How a pairing is going, in a line: red once it failed */
function pairingLine(stage: PairingStage, quiet: string, style: string): HTMLElement {
  return h('p', { class: stage.kind === 'failed' ? 'wa-error' : quiet, style }, describePairing(stage));
}

function describePairing(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Looking for your computer…';
    case 'confirm':
    case 'compare':
      return 'Check your computer shows the same code, and confirm there.';
    case 'sending':
      return 'The codes matched. Setting up this phone…';
    case 'joining':
      return `Adding your spaces: ${stage.joined} of ${stage.total}…`;
    case 'received':
      return stage.spaces === 1 ? 'Added 1 space.' : `Added ${stage.spaces} spaces.`;
    case 'sent':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

export class MincaAuthElement extends Base {
  #auth: MincaAuth | null = null;
  #unsubscribe: (() => void) | null = null;
  #announced: MincaSession | null | undefined = undefined;

  // What only this element cares about: which fold is open, what is typed.
  #drafts = new Map<string, string>();
  #filledAs = '';
  #copied = false;
  #stored = false;
  #choosingPassword = false;
  #showPairHelp = false;
  #mismatch = false;
  #lastSelected: string | null = null;
  #lastStage: string | null = null;
  /** The username on the create screen: picked from the name until it is typed, and whether it is free */
  #username: { typed: boolean; checked: string; state: NameState } = {
    typed: false,
    checked: '',
    state: 'empty',
  };
  #usernameTimer: ReturnType<typeof setTimeout> | undefined;

  /** The flow this element draws. Set it to share one with the rest of the page; otherwise one is made from the attributes. */
  get auth(): MincaAuth {
    this.#auth ??= createMincaAuth({
      ...(this.getAttribute('app-name') ? { appName: this.getAttribute('app-name')! } : {}),
      network: { relays: this.#urls('relays'), nodes: this.#urls('nodes') },
    });
    return this.#auth;
  }

  /** A comma-separated attribute's addresses */
  #urls(name: string): string[] {
    return (this.getAttribute(name) ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);
  }

  set auth(auth: MincaAuth) {
    if (auth === this.#auth) return;
    this.#auth = auth;
    if (this.isConnected) this.#follow();
  }

  /**
   * Draws an account's avatar from its DID, round or not. A page that shows
   * accounts its own way sets this, so an account looks the same here as
   * everywhere else on it; otherwise a simple one is drawn.
   */
  get avatar(): ((did: string, size: number, round: boolean) => Element) | null {
    return this.#avatar;
  }

  set avatar(draw: ((did: string, size: number, round: boolean) => Element) | null) {
    this.#avatar = draw;
    if (this.isConnected) this.#redraw();
  }

  #avatar: ((did: string, size: number, round: boolean) => Element) | null = null;

  /** `round` inside something round already (a pill row), where corners would fight it */
  #drawAvatar(did: string, size = 32, round = false): Element {
    const drawn = this.#avatar?.(did, size, round) ?? avatar(did, size);
    drawn.classList.add('wa-avatar');
    if (round) drawn.classList.add('wa-avatar-round');
    return drawn;
  }

  connectedCallback(): void {
    adoptStyles('minca-auth', AUTH_CSS);
    if (this.#auth) {
      this.#follow();
      return;
    }
    // A framework may set `auth` just after inserting the element; wait a
    // moment before making one from the attributes instead.
    queueMicrotask(() => {
      if (this.isConnected && !this.#unsubscribe) this.#follow();
    });
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #follow(): void {
    this.#unsubscribe?.();
    const auth = this.auth;
    this.#unsubscribe = auth.subscribe((state) => this.#changed(state));
    this.#changed(auth.getState());
    void auth.start();
  }

  #changed(state: AuthState): void {
    // A new account row, or a new screen, starts with empty fields.
    if (state.selectedId !== this.#lastSelected || state.stage !== this.#lastStage) {
      this.#lastSelected = state.selectedId;
      this.#lastStage = state.stage;
      this.#reset();
    }
    this.#render(state);

    const session = state.stage === 'ready' ? state.session : null;
    if (session !== this.#announced) {
      this.#announced = session;
      this.dispatchEvent(
        new CustomEvent<MincaSessionEventDetail>('minca-session', {
          detail: { session },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  #reset(): void {
    this.#drafts.clear();
    clearTimeout(this.#usernameTimer);
    this.#username = { typed: false, checked: '', state: 'empty' };
    this.#filledAs = '';
    this.#copied = false;
    this.#stored = false;
    this.#choosingPassword = false;
    this.#showPairHelp = false;
    this.#mismatch = false;
  }

  #redraw(): void {
    this.#render(this.auth.getState());
  }

  /** Redraws, keeping focus and what was typed. */
  #render(state: AuthState): void {
    const active = globalThis.document.activeElement;
    const focused = active instanceof HTMLElement && this.contains(active) ? active.dataset.key : undefined;

    this.replaceChildren(...this.#screen(state));

    const again = focused
      ? this.querySelector<HTMLInputElement>(`[data-key="${focused}"]`)
      : this.querySelector<HTMLInputElement>('[autofocus]');
    again?.focus();
  }

  /** An input that survives a redraw */
  #input(key: string, props: Record<string, unknown>): HTMLInputElement {
    const input = h('input', {
      ...props,
      'data-key': key,
      value: this.#drafts.get(key) ?? props.value ?? '',
      oninput: () => this.#drafts.set(key, input.value),
    });
    return input;
  }

  #screen(state: AuthState): HTMLElement[] {
    switch (state.stage) {
      case 'ready':
        return [];
      case 'starting':
        return [
          h(
            'div',
            { class: 'wa-card' },
            h('p', { class: 'wa-hint' }, state.signingOut ? 'Signing out…' : 'Looking for your accounts…'),
          ),
        ];
      case 'pair':
        return [this.#pair(state)];
      case 'create':
        return [this.#create(state)];
      case 'recovery':
        return [this.#recovery(state)];
      case 'unlock':
        return [this.#unlock(state)];
      case 'pod':
        return [this.#pod(state)];
      case 'welcome':
        return [this.#welcome(state)];
      case 'existing':
        return [this.#existing(state)];
      case 'restore':
        return [this.#restore(state)];
      case 'signIn':
        return [this.#signIn(state)];
    }
  }

  /** Where accounts are read from, shown only when it is a pod — a new person should not have to think about it. */
  #podLine(state: AuthState): HTMLElement | null {
    const place = state.place;
    if (place?.kind !== 'folder') return null;
    return h(
      'p',
      { class: 'wa-small', style: 'margin-top:24px' },
      `Pod: ${place.directory?.name ?? 'your folder'} · `,
      link('Use this browser instead', () => void this.auth.useBrowser(), state.busy),
    );
  }

  // ─── New here, or not ──────────────────────────────────────────────

  #welcome(state: AuthState): HTMLElement {
    const auth = this.auth;
    return card(
      'Welcome to Minca',
      subtitle('One account for every Minca app. Your data stays with you, not on a server.'),
      h(
        'div',
        { class: 'wa-options' },
        state.podToReopen && state.folderAvailable
          ? option(
              `Open “${state.podToReopen}” again`,
              'Your account is in this folder. The browser asks once more before opening it.',
              () => void auth.reopenPod(),
              state.busy,
            )
          : null,
        option(
          'Create an account',
          "Takes a minute. You'll get a recovery code to keep safe, then sign in with a passkey or a password.",
          () => auth.startCreating(),
          state.busy,
        ),
        state.folderAvailable
          ? option(
              'Open a folder',
              'Your account is in a folder (a pod): open it, and sign in with your password or passkey.',
              () => void auth.choosePod(),
              state.busy,
            )
          : null,
        option(
          'I already have one',
          'Use your recovery code, or add this device from another.',
          () => auth.showExisting(),
          state.busy,
        ),
      ),
      errorBox(state.error),
      this.#podLine(state),
    );
  }

  /**
   * "I already have an account", from a place that does not list it. Where the
   * data lives comes up here and only here: someone with a pod has something to
   * point at, and someone without one has other ways in.
   */
  #existing(state: AuthState): HTMLElement {
    const auth = this.auth;
    return card(
      'Find your account',
      subtitle('Any of these gets you in.'),
      h(
        'div',
        { class: 'wa-options' },
        state.folderAvailable
          ? option(
              'Open your pod',
              'The folder your Minca data lives in. Its accounts are listed next, ready to unlock with your passkey or password.',
              () => void auth.choosePod(),
              state.busy,
            )
          : null,
        option(
          'Add this device from another',
          'From a device where you are signed in. Nothing to type — your spaces come across too.',
          () => {
            this.#showPairHelp = !this.#showPairHelp;
            this.#redraw();
          },
          state.busy,
        ),
        this.#showPairHelp
          ? h(
              'ol',
              { class: 'wa-steps' },
              h('li', null, 'On the signed-in device, open your account page.'),
              h('li', null, 'Choose ', h('strong', null, 'Add your phone'), ' and show the pairing code.'),
              h('li', null, "Scan it with this device's camera and open the link."),
            )
          : null,
        option(
          'Use your recovery code',
          'The 26-character code you kept when you made the account. Works on any device.',
          () => auth.showRestore(),
          state.busy,
        ),
      ),
      errorBox(state.error),
      links(
        link('Back', () => (state.accounts.length > 0 ? auth.showSignIn() : auth.showWelcome()), state.busy),
        link('Create a new account instead', () => auth.startCreating(), state.busy),
      ),
      this.#podLine(state),
    );
  }

  // ─── Choosing an account, and getting in ───────────────────────────

  /**
   * The recovery-code form. A password form, because before passwords the
   * recovery code was this site's login and many managers hold it that way.
   * Its username is writable: a manager fills the whole credential at once,
   * and letting it overwrite the name is what makes a mismatch detectable.
   */
  #codeForm(state: AuthState, selected: AccountSummary | null): HTMLElement[] {
    const username = offscreenUsername(accountCredentialName(selected?.name ?? 'My account'), false);

    const code = this.#input('code', {
      type: 'password',
      name: 'password',
      placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX',
      autocomplete: 'current-password',
      spellcheck: 'false',
      autofocus: true,
      'aria-label': 'Recovery code',
      disabled: state.busy,
    });
    // Autofill sets the DOM value directly; read what it filled as well.
    code.addEventListener('input', () => {
      const filled = username.value.trim();
      if (filled !== this.#filledAs) {
        this.#filledAs = filled;
        this.#redraw();
      }
    });

    const wrong =
      selected !== null && this.#filledAs !== '' && this.#filledAs !== accountCredentialName(selected.name);
    return [
      form(
        () => {
          const value = code.value.trim();
          if (value) void this.auth.signInWithCode(value);
        },
        {},
        username,
        code,
        submit(state.busy, 'Continue', 'Opening…'),
      ),
      wrong
        ? h(
            'p',
            { class: 'wa-error', style: 'margin-top:10px' },
            'Your password manager filled ',
            h('strong', null, this.#filledAs),
            ', not ',
            h('strong', null, selected.name),
            '. Pick the entry named ',
            h('strong', null, selected.name),
            ', or open that account instead.',
          )
        : null,
    ].filter((node) => node !== null);
  }

  /** The everyday password, filed under the account's name so a manager fills the right one. */
  #passwordForm(state: AuthState, account: AccountSummary, secondary = false): HTMLElement {
    const password = this.#input('password', {
      type: 'password',
      name: 'password',
      placeholder: 'Password',
      autocomplete: 'current-password',
      'aria-label': 'Password',
      disabled: state.busy,
    });
    return form(
      () => {
        if (password.value) void this.auth.signInWithPassword(password.value);
      },
      {},
      offscreenUsername(accountCredentialName(account.name), true),
      password,
      secondary
        ? h(
            'button',
            { type: 'submit', class: 'wa-secondary wa-wide', disabled: state.busy },
            'Sign in with password',
          )
        : submit(state.busy, 'Sign in', 'Signing in…'),
    );
  }

  #signIn(state: AuthState): HTMLElement {
    const auth = this.auth;
    const { accounts, entry, place } = state;
    const selected = accounts.find((account) => account.id === state.selectedId) ?? null;

    /** The ways into the open account: one main button, the rest set back */
    const waysIn = (account: AccountSummary, open: AccountEntry): Child[] => {
      const hasPasskey = open.shortcuts.length > 0;
      // An account with wraps, none of them usable here, has been used on
      // another site — a passkey works on one web address only.
      const seenElsewhere = open.vault.wraps.length > 0;
      if (!hasPasskey && !open.hasPassword)
        return [
          h(
            'p',
            { class: 'wa-small', style: 'margin:0 0 10px' },
            'No passkey or password here yet. Use your recovery code once, then choose one.',
            info(
              'Why it is asking for the recovery code',
              seenElsewhere
                ? 'This account’s passkeys belong to the sites that made them — a passkey works on one web address only. The recovery code opens it anywhere.'
                : 'The recovery code opens the account anywhere, with nothing stored. Next you set up a passkey or password so it stops asking.',
            ),
          ),
          ...this.#codeForm(state, selected),
        ];
      return [
        hasPasskey
          ? button(
              state.busy ? 'Waiting…' : 'Sign in with passkey',
              () => void auth.signInWithPasskey(),
              state.busy,
              'passkey',
            )
          : null,
        hasPasskey && open.hasPassword ? h('div', { class: 'wa-or' }, 'or') : null,
        open.hasPassword ? this.#passwordForm(state, account, hasPasskey) : null,
        h(
          'p',
          { class: 'wa-small', style: 'margin-top:12px' },
          'Forgot it? ',
          link('Use your recovery code', () => auth.showRestore(), state.busy),
        ),
      ];
    };

    // The one being signed in to first, then the rest to switch to.
    const ordered = [...accounts].sort(
      (a, b) => Number(b.id === state.selectedId) - Number(a.id === state.selectedId),
    );
    const rows = ordered.map((account) => {
      const isOpen = account.id === state.selectedId && entry !== null;
      if (isOpen)
        return h(
          'div',
          { class: 'wa-account wa-account-open' },
          h(
            'div',
            { class: 'wa-account-head' },
            this.#drawAvatar(account.did, 48),
            h('span', { class: 'wa-account-name' }, account.name),
          ),
          ...waysIn(account, entry),
        );
      return h(
        'button',
        {
          type: 'button',
          class: 'wa-account wa-account-row',
          disabled: state.busy,
          onclick: () => void auth.select(account.id),
        },
        this.#drawAvatar(account.did, 32, true),
        h('span', { class: 'wa-account-name', style: 'flex:1;min-width:0' }, account.name),
        h('span', { class: 'wa-chevron', 'aria-hidden': 'true' }, '›'),
      );
    });

    const one = accounts.length === 1 ? accounts[0] : undefined;
    return card(
      'Welcome back',
      subtitle(
        one
          ? `Sign in as ${one.name}.`
          : accounts.length > 0
            ? 'Choose your account.'
            : 'There are no accounts here yet.',
      ),
      h('div', { class: 'wa-accounts' }, ...rows),
      errorBox(state.error),
      h(
        'div',
        { class: 'wa-footer' },
        links(
          link('Another account', () => auth.showExisting(), state.busy),
          link('Create a new account', () => auth.startCreating(), state.busy),
        ),
        place
          ? h(
              'p',
              { class: 'wa-small', style: 'margin-top:4px' },
              place.kind === 'folder'
                ? `Accounts in the folder “${place.directory?.name ?? 'your pod'}”`
                : 'Accounts kept in this browser',
              state.folderAvailable ? ' · ' : null,
              state.folderAvailable
                ? link(
                    place.kind === 'folder' ? 'Open another folder' : 'Open a folder',
                    () => void auth.choosePod(),
                    state.busy,
                  )
                : null,
              state.folderAvailable && place.kind === 'folder'
                ? link('Use this browser', () => void auth.useBrowser(), state.busy)
                : null,
            )
          : null,
      ),
    );
  }

  /** The recovery code, typed in: on a new device, or when no everyday way in is to hand. */
  #restore(state: AuthState): HTMLElement {
    const auth = this.auth;
    const selected = state.accounts.find((account) => account.id === state.selectedId) ?? null;
    // From the account list it restores that account; from "I already have one", any.
    const forSelected = selected !== null && state.accounts.length > 0 && state.entry !== null;
    return card(
      'Use your recovery code',
      subtitle(
        forSelected ? `For ${selected.name}. ` : '',
        'The 26-character code you kept when you made the account.',
      ),
      ...this.#codeForm(state, forSelected ? selected : null),
      errorBox(state.error),
      links(
        link('Back', () => (state.accounts.length > 0 ? auth.showSignIn() : auth.showExisting()), state.busy),
      ),
      h(
        'p',
        { class: 'wa-small', style: 'margin-top:16px' },
        "Lost it? If you're signed in on another device, add this one from there instead.",
      ),
    );
  }

  // ─── Making an account ─────────────────────────────────────────────

  #create(state: AuthState): HTMLElement {
    const auth = this.auth;
    const domain = auth.usernames;
    const name = this.#input('name', {
      type: 'text',
      placeholder: 'Your name',
      autocomplete: 'off',
      autofocus: true,
      disabled: state.busy,
      'aria-label': 'Your name',
    });
    if (!domain)
      return card(
        'Create your account',
        subtitle('What should apps call you? You can change it later.'),
        form(
          () => {
            if (name.value.trim()) void auth.createAccount(name.value.trim());
          },
          {},
          name,
          submit(state.busy, 'Continue', 'Creating…'),
        ),
        h(
          'p',
          { class: 'wa-small' },
          'Next: a recovery code to keep safe, then a passkey or password for signing in.',
        ),
        errorBox(state.error),
        links(link('I already have an account', () => auth.showExisting(), state.busy)),
        this.#podLine(state),
      );

    const username = this.#input('username', {
      type: 'text',
      placeholder: 'yourname',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      maxlength: '64',
      disabled: state.busy,
      'aria-label': 'Username',
    });
    const status = h('p', { class: 'wa-small', style: 'margin-top:0', 'aria-live': 'polite' });
    const show = () => {
      const { state: now } = this.#username;
      const typed = username.value.trim().toLowerCase();
      status.dataset.name = now;
      status.textContent =
        now === 'free'
          ? `${typed}@${domain} is yours if you want it`
          : now === 'taken'
            ? 'Someone has that one. Try another?'
            : now === 'invalid'
              ? 'Letters, numbers, dots, dashes and underscores'
              : now === 'checking'
                ? 'Checking…'
                : 'How people find you and add you. Leave it empty to skip.';
    };
    // Looks the name up a moment after typing stops; picked from the name, a taken one gives way to the next idea.
    const check = (ideas: ReadonlyArray<string>) => {
      clearTimeout(this.#usernameTimer);
      const typed = username.value.trim().toLowerCase();
      const parsed = typed ? parseUsername(`${typed}@${domain}`) : null;
      this.#username.checked = typed;
      this.#username.state = !typed ? 'empty' : parsed ? 'checking' : 'invalid';
      show();
      if (!parsed) return;
      this.#usernameTimer = setTimeout(() => {
        void resolveUsername(formatUsername(parsed), provider)
          .then(
            () => 'taken' as const,
            () => 'free' as const,
          )
          .then((found) => {
            if (this.#username.checked !== typed) return;
            const next = ideas[ideas.indexOf(typed) + 1];
            if (found === 'taken' && !this.#username.typed && next) {
              username.value = next;
              this.#drafts.set('username', next);
              return check(ideas);
            }
            this.#username.state = found;
            show();
          });
      }, 300);
    };
    name.addEventListener('input', () => {
      if (this.#username.typed) return;
      const ideas = usernameIdeas(name.value);
      username.value = ideas[0] ?? '';
      this.#drafts.set('username', username.value);
      check(ideas);
    });
    username.addEventListener('input', () => {
      this.#username.typed = true;
      check([]);
    });
    show();

    return card(
      'Create your account',
      subtitle('What apps call you, and the name people find you by. You can change both later.'),
      form(
        () => {
          const typed = username.value.trim().toLowerCase();
          if (!name.value.trim() || this.#username.state === 'taken' || this.#username.state === 'invalid')
            return;
          void auth.createAccount(name.value.trim(), typed ? { username: `${typed}@${domain}` } : {});
        },
        {},
        h('label', { class: 'wa-label' }, 'Name'),
        name,
        h('label', { class: 'wa-label' }, 'Username'),
        h('div', { class: 'wa-username' }, username, h('span', null, `@${domain}`)),
        status,
        submit(state.busy, 'Continue', 'Creating…'),
      ),
      h(
        'p',
        { class: 'wa-small' },
        'Next: a recovery code to keep safe, then a passkey or password for signing in.',
      ),
      errorBox(state.error),
      links(link('I already have an account', () => auth.showExisting(), state.busy)),
      this.#podLine(state),
    );
  }

  /**
   * The recovery code, to keep.
   *
   * Deliberately not a password form: saved as this site's login, a manager
   * would later offer it in the everyday password field — and replace it with
   * that password when one is set, losing the only copy. So it is copied or
   * downloaded, and kept as a note or on paper.
   */
  #recovery(state: AuthState): HTMLElement {
    const auth = this.auth;
    const code = state.freshCode ?? '';
    const account = state.session?.account;
    return card(
      'Your recovery code',
      claimLine(state),
      h(
        'p',
        { class: 'wa-hint' },
        'This code is your account. With it you can restore your account on any device, even if you lose everything else.',
        info(
          'Why it matters',
          'Nobody can reissue it: there is no server that knows your account. Anyone who has it can open your account, so keep it private. ',
          'Save it as a secure note in your password manager, or print it and put it away — not as a login for this site, where a new password could replace it.',
        ),
      ),
      h('code', { class: 'wa-code wa-code-large' }, code),
      h(
        'div',
        { class: 'wa-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'wa-secondary',
            onclick: () => {
              void globalThis.navigator.clipboard
                ?.writeText(code)
                .then(() => {
                  this.#copied = true;
                  this.#redraw();
                })
                .catch(() => {});
            },
          },
          this.#copied ? 'Copied' : 'Copy',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'wa-secondary',
            onclick: () =>
              download(
                recoveryKit({ code, name: account?.name ?? 'My account', did: state.session?.did ?? '' }),
              ),
          },
          'Download',
        ),
      ),
      h(
        'label',
        { class: 'wa-check' },
        h('input', {
          type: 'checkbox',
          checked: this.#stored,
          onchange: (event: Event) => {
            if (event.target instanceof HTMLInputElement) this.#stored = event.target.checked;
            this.#redraw();
          },
        }),
        h('span', null, "I've stored my recovery code somewhere safe."),
      ),
      button('Continue', () => auth.codeSaved(), !this.#stored),
    );
  }

  /**
   * How this account is opened every day. Not skippable: without one, every
   * visit asks for the recovery code, and it ends up being used as a password
   * after all.
   */
  #unlock(state: AuthState): HTMLElement {
    const auth = this.auth;
    const account = state.session?.account;
    const passkeys = typeof globalThis.PublicKeyCredential !== 'undefined';

    const choosing = this.#choosingPassword || !passkeys;
    const passwordForm = () => {
      const password = this.#input('new-password', {
        type: 'password',
        name: 'password',
        placeholder: 'Password',
        autocomplete: 'new-password',
        autofocus: true,
        'aria-label': 'Password',
        'aria-describedby': 'wa-strength',
        disabled: state.busy,
      });
      // How strong it is, as it is typed: a warning, never a refusal.
      const meter = h('div', { class: 'wa-meter', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'));
      const strength = h('p', { id: 'wa-strength', class: 'wa-small', 'aria-live': 'polite' });
      const measure = () => {
        const check = passwordStrength(password.value);
        meter.dataset.strength = password.value ? check.strength : '';
        strength.dataset.strength = password.value ? check.strength : '';
        strength.textContent = check.hint || 'Any password works. A password manager can make a strong one.';
      };
      password.addEventListener('input', measure);
      measure();
      const confirm = this.#input('confirm-password', {
        type: 'password',
        name: 'confirm-password',
        placeholder: 'The same again',
        autocomplete: 'new-password',
        'aria-label': 'Confirm password',
        disabled: state.busy,
      });
      return form(
        () => {
          this.#mismatch = password.value !== confirm.value;
          if (this.#mismatch) {
            this.#redraw();
            return;
          }
          const chosen = password.value;
          const filedAs = accountCredentialName(account?.name ?? 'My account');
          void auth.setPassword(chosen).then((ok) => (ok ? offerToSave(filedAs, chosen, filedAs) : false));
        },
        { style: passkeys ? 'margin-top:12px' : '' },
        // A visible username is what makes a manager file the password under the account's name.
        h('input', {
          type: 'text',
          name: 'username',
          autocomplete: 'username',
          value: accountCredentialName(account?.name ?? 'My account'),
          readonly: true,
          'aria-label': 'Account',
        }),
        password,
        meter,
        strength,
        confirm,
        this.#mismatch ? h('p', { class: 'wa-error' }, 'Those two do not match.') : null,
        submit(state.busy, 'Use this password', 'Saving…'),
      );
    };

    return card(
      'How do you want to sign in?',
      claimLine(state),
      subtitle(
        'This is what you will use every day.',
        info(
          'Where it works',
          'A passkey signs you in on this site, in this browser. A password works wherever your account is kept — this browser, or your pod in any app pointed at it. On a new device, add it from this one or use your recovery code.',
        ),
      ),
      h(
        'div',
        { class: 'wa-options' },
        passkeys
          ? option(
              'Passkey',
              'Touch ID, Windows Hello, or your password manager. Nothing to type.',
              () => void auth.addPasskey(),
              state.busy,
              true,
            )
          : null,
        passkeys && !choosing
          ? option(
              'Password',
              'Saved in your password manager, like any other login.',
              () => {
                this.#choosingPassword = true;
                this.#redraw();
              },
              state.busy,
            )
          : null,
      ),
      choosing ? passwordForm() : null,
      // The code was typed into a password field: saved as this site's login, the password set now would replace it.
      state.setup === 'restored'
        ? h(
            'p',
            { class: 'wa-small', style: 'margin-top:16px' },
            'If your browser offered to save the recovery code as a password, don’t — the password you set now would replace it. Keep the code where you had it.',
          )
        : null,
      state.setup === 'paired' && state.pairingStage
        ? pairingLine(state.pairingStage, 'wa-small', 'margin-top:16px')
        : null,
      // The app waits in the tab it opened; the camera opened this one.
      state.setup === 'paired'
        ? h('p', { class: 'wa-small' }, 'If an app sent you to sign in, you can go back to it now.')
        : null,
      errorBox(state.error),
    );
  }

  /** Offered once, at the end of making an account in a browser that can open a folder. */
  #pod(state: AuthState): HTMLElement {
    const auth = this.auth;
    return card(
      'Keep your data in a folder?',
      h(
        'p',
        { class: 'wa-hint' },
        'A pod is a folder on your computer that keeps your account and spaces. Back it up, or put it in iCloud or Dropbox. Any Minca app you point at it opens the same account. It is brought up to date while this page is open.',
      ),
      h(
        'div',
        { class: 'wa-options' },
        option(
          'Choose a folder',
          'Your browser will ask to see it, then to save into it.',
          () => void auth.choosePod(),
          state.busy,
        ),
      ),
      errorBox(state.error),
      links(link('Not now — keep it in this browser', () => auth.finishSetup(), state.busy)),
      h('p', { class: 'wa-small' }, 'You can move it to a pod any time from your account page.'),
    );
  }

  // ─── Arriving from a phone-pairing QR code ─────────────────────────

  /**
   * One button. The link holds only where to meet, but meeting still takes a
   * tap: a page that went looking the instant it loaded would pair from a link
   * someone had merely opened by accident. Once the computer answers, both show
   * the same code, and the account comes over only after the person confirms
   * it there.
   */
  #pair(state: AuthState): HTMLElement {
    const auth = this.auth;
    const arrival = state.pairingArrival;
    if (arrival && state.session) return this.#pairArrived(state, arrival, state.session.account.name);
    const stage = state.pairingStage;
    const code = stage?.kind === 'confirm' ? stage.code : null;
    // The codes matched and the account is here: nothing left to tap or warn about.
    const arriving = stage?.kind === 'sending';
    return card(
      state.session ? 'Add an account' : 'Add this phone',
      subtitle('You scanned a code from your computer.'),
      code
        ? h(
            'code',
            { class: 'wa-code wa-code-large', style: 'font-size:28px' },
            `${code.slice(0, 3)} ${code.slice(3)}`,
          )
        : h(
            'p',
            { class: 'wa-hint' },
            state.session
              ? `This phone is signed in as ${state.session.account.name}. Pairing brings the account on the computer showing the code; you choose whether to add it once it arrives.`
              : 'This phone becomes the same account, with its own copy of your spaces.',
            info(
              'What happens next',
              'Your computer and this phone show the same six digits. When you confirm them on the computer, it sends the account here directly — the relay only introduces the two, and sees nothing it could use.',
            ),
          ),
      state.accounts.length > 0 && !code && !arriving
        ? h(
            'p',
            { class: 'wa-error' },
            'Only continue if the code is on your own screen, in front of you. A link someone sent you would put this phone in their account instead of yours.',
          )
        : null,
      state.pairing && !code && !arriving
        ? button(state.busy ? 'Looking…' : 'Continue', () => void auth.acceptPairing(), state.busy)
        : null,
      stage ? pairingLine(stage, 'wa-hint', 'margin-top:12px') : null,
      errorBox(state.error),
      h('p', { class: 'wa-small' }, 'Keep the code showing on your computer until this finishes.'),
      links(link(state.pairing ? 'Not now' : 'Back', () => auth.dismissPairing(), state.busy && !code)),
    );
  }

  /** The account a pairing brought, to a phone signed in to another: add it, or switch to it if it is already here */
  #pairArrived(
    state: AuthState,
    arrival: NonNullable<AuthState['pairingArrival']>,
    current: string,
  ): HTMLElement {
    const auth = this.auth;
    const known = arrival.account;
    return card(
      known ? `Switch to ${known.name}?` : 'Add this account?',
      h(
        'div',
        { class: 'wa-row', style: 'align-items:center;gap:12px' },
        this.#drawAvatar(arrival.did, 40),
        h(
          'p',
          { class: 'wa-hint', style: 'margin:0' },
          known
            ? `The computer that showed the code sent ${known.name}, which is already on this phone. Switch to it? ${current} stays here, to switch back to.`
            : `The computer that showed the code sent a different account from ${current}, one this phone doesn't have. Add it only if it is yours: if you meant to add this phone to ${current}, it already is, and this account is someone else's.`,
        ),
      ),
      button(
        known ? `Switch to ${known.name}` : 'Add and switch',
        () => void auth.answerPairing(true),
        state.busy,
      ),
      errorBox(state.error),
      links(link(`Stay as ${current}`, () => void auth.answerPairing(false), state.busy)),
    );
  }
}

/** Registers `<minca-auth>`, once. Importing this module does it for you. */
export function defineMincaAuth(tag = 'minca-auth'): void {
  const registry = globalThis.customElements;
  if (registry && !registry.get(tag)) registry.define(tag, MincaAuthElement);
}

defineMincaAuth();

declare global {
  interface HTMLElementTagNameMap {
    'minca-auth': MincaAuthElement;
  }
  interface HTMLElementEventMap {
    'minca-session': CustomEvent<MincaSessionEventDetail>;
  }
}
