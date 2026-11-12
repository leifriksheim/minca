/**
 * @module session/credentials
 * Getting a password manager to actually keep something.
 *
 * Managers guess whether to offer saving from the shape of a form and the
 * navigation that follows submitting it. Sign-in here submits nothing and never
 * navigates, so the forms keep a real, laid-out username field, and this asks
 * outright where the browser supports being asked.
 */

/** The Credential Management API, which only Chromium browsers implement. */
interface PasswordCredentialConstructor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

function isPasswordCredentialConstructor(value: unknown): value is PasswordCredentialConstructor {
  return typeof value === 'function';
}

/**
 * Offers a credential to the browser's password manager. Best effort: Firefox
 * and Safari have no such API, and a manager may decline.
 *
 * @param id What to file it under, which is what the user will see in the vault
 * @param name A longer label, where the manager shows one
 * @returns Whether the browser was asked at all
 */
export async function offerToSave(id: string, password: string, name?: string): Promise<boolean> {
  const Ctor: unknown = Reflect.get(globalThis, 'PasswordCredential');
  if (!isPasswordCredentialConstructor(Ctor)) return false;
  try {
    await globalThis.navigator.credentials.store(new Ctor({ id, password, ...(name ? { name } : {}) }));
    return true;
  } catch {
    // Declined, or blocked by policy.
    return false;
  }
}

/** What a password manager should file the account's password under: the account's own name */
export function accountCredentialName(name: string): string {
  return name;
}

/** The recovery code as a plain text file to keep, naming the account and its DID */
export function recoveryKit({ code, name, did }: { code: string; name: string; did: string }): {
  filename: string;
  text: string;
} {
  const text = [
    'Minca recovery code',
    '',
    `Account:       ${name}`,
    ...(did ? [`Account ID:    ${did}`] : []),
    `Recovery code: ${code}`,
    '',
    'This code is your Minca account. It restores the account on any device or',
    'Minca home, even one that has never seen it. Nobody can reissue it, and',
    'anyone who has it can open your account.',
    '',
    'Keep it somewhere safe: a secure note in your password manager, or printed',
    'and put away. Not as a saved login, where a new password could replace it.',
    '',
    `Made ${new Date().toISOString().slice(0, 10)}.`,
    '',
  ].join('\n');
  return { filename: `minca-recovery-${slugOf(name)}.txt`, text };
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'account';
