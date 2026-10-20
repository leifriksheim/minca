/**
 * @module session/account-hint
 * Which account an app acts for, when it opens the person's account home:
 * `#account=<did>` on the home's address. In the fragment, so the server that
 * serves the home never sees it.
 *
 * Only a hint. Any page can open the home with any DID, so the home shows
 * which account was asked for and lets the person choose; it never signs out
 * or switches on a hint alone.
 */
import { P256_MULTICODEC, didToPublicKey } from '../identity/did.js';

const HINT = /[#&]account=([^&]+)/;

/**
 * The address of the account page beside the home's connect page, saying
 * which account the app acts for.
 * @param home The home's address, as the connection remembers it
 * @param did The account the app acts for
 * @param section A part of the page to open at, such as `notifications`
 */
export function accountHomeLink(home: string, did: string, section?: string): string {
  const url = new URL('.', home);
  const hint = `account=${encodeURIComponent(did)}`;
  url.hash = section ? `${section}&${hint}` : hint;
  return url.href;
}

/** The account this page was opened for, if the link said and it is a DID at all */
export function readAccountHint(): string | null {
  const match = HINT.exec(globalThis.location?.hash ?? '');
  if (!match?.[1]) return null;
  try {
    const did = decodeURIComponent(match[1]);
    // An account is a compressed P-256 key; `didToPublicKey` alone does not check which kind.
    const { publicKeyBytes, multicodecPrefix } = didToPublicKey(did);
    const p256 =
      multicodecPrefix.length === P256_MULTICODEC.length &&
      multicodecPrefix.every((byte, at) => byte === P256_MULTICODEC[at]);
    return p256 && publicKeyBytes.length === 33 ? did : null;
  } catch {
    return null;
  }
}

/** Takes the hint out of the address, leaving any section, so a refresh or a shared link does not carry it */
export function clearAccountHint(): void {
  const { location, history } = globalThis;
  if (!location || !history || !HINT.test(location.hash)) return;
  const rest = location.hash.replace(HINT, '').replace(/^#?&?/, '');
  history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
}
