/** Vault helpers only tests need: inspecting wraps */
import type { AccountVault } from '../../src/identity/account-vault.js';

export function hasPassphraseWrap(vault: AccountVault): boolean {
  return vault.wraps.some((wrap) => wrap.kind === 'passphrase');
}

export function withoutWrap(vault: AccountVault, id: string): AccountVault {
  return { ...vault, wraps: vault.wraps.filter((wrap) => wrap.id !== id) };
}
