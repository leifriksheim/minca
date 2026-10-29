import { base64UrlEncode, base64UrlDecode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource, isPublicKeyCredential } from '../utils/guards.js';

type PasskeyHint = 'client-device' | 'security-key' | 'hybrid';

export interface PasskeyOptions {
  readonly rpId: string;
  readonly rpName: string;
  readonly userName: string;
  readonly userId?: Uint8Array;
  /** Which authenticator the browser offers first; `client-device` favours Touch ID or Windows Hello */
  readonly hints?: ReadonlyArray<PasskeyHint>;
  /** Restrict to platform or roaming authenticators */
  readonly attachment?: AuthenticatorAttachment;
}

export interface PasskeyRegistration {
  readonly credentialId: string;
  /** The user handle, base64url: keep it to rename the passkey later ({@link renamePasskey}) */
  readonly userHandle: string;
}

export interface AuthOptions {
  readonly rpId?: string;
  /** See {@link PasskeyOptions.hints} */
  readonly hints?: ReadonlyArray<PasskeyHint>;
}

export interface PasskeyAuth {
  readonly credentialId: string;
}

/**
 * Whether this device has a built-in authenticator — Touch ID, Windows Hello.
 * Worth knowing first: `attachment: 'platform'` is a filter, not a preference.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  try {
    return (await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? false;
  } catch {
    return false;
  }
}

/** Registers a new passkey */
export async function registerPasskey(options: PasskeyOptions): Promise<PasskeyRegistration> {
  const credentials = credentialsApi();
  const userId = options.userId || globalThis.crypto.getRandomValues(new Uint8Array(32));

  const createOptions: PublicKeyCredentialCreationOptions & { hints?: string[] } = {
    rp: { id: options.rpId, name: options.rpName },
    user: { id: bufferSource(userId), name: options.userName, displayName: options.userName },
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      // Discoverable, so a later visit finds it without remembering anything about the user.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
      ...(options.attachment ? { authenticatorAttachment: options.attachment } : {}),
    },
    ...(options.hints ? { hints: [...options.hints] } : {}),
  };

  const credential = await credentials.create({ publicKey: createOptions });
  if (!isPublicKeyCredential(credential)) throw new Error('Failed to create passkey.');
  return Object.freeze({ credentialId: idOf(credential), userHandle: base64UrlEncode(userId) });
}

/**
 * Asks the passkey provider to show a passkey under a new name, through the
 * WebAuthn Signal API; the provider decides. True when the browser accepted
 * the request, not when the provider acted on it.
 */
export async function renamePasskey(params: {
  rpId: string;
  userHandle: string;
  name: string;
}): Promise<boolean> {
  // Not in TypeScript's DOM types yet.
  const api:
    | (typeof PublicKeyCredential & {
        signalCurrentUserDetails?: (details: {
          rpId: string;
          userId: string;
          name: string;
          displayName: string;
        }) => Promise<void>;
      })
    | undefined = globalThis.PublicKeyCredential;
  const signal = api?.signalCurrentUserDetails;
  if (typeof signal !== 'function') return false;
  try {
    await signal.call(globalThis.PublicKeyCredential, {
      rpId: params.rpId,
      userId: params.userHandle,
      name: params.name,
      displayName: params.name,
    });
    return true;
  } catch {
    return false;
  }
}

/** Authenticates with a passkey: this credential, or any of this origin's when omitted */
export async function authenticatePasskey(
  credentialId?: string,
  options?: AuthOptions,
): Promise<PasskeyAuth> {
  const credentials = credentialsApi();
  const getOptions: PublicKeyCredentialRequestOptions & { hints?: string[] } = {
    challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    rpId: options?.rpId,
    userVerification: 'required',
    ...(options?.hints ? { hints: [...options.hints] } : {}),
    // Without it the browser offers any passkey on the origin.
    ...(credentialId
      ? {
          allowCredentials: [
            { type: 'public-key' as const, id: bufferSource(base64UrlDecode(credentialId)) },
          ],
        }
      : {}),
  };

  const credential = await credentials.get({ publicKey: getOptions });
  if (!isPublicKeyCredential(credential)) throw new Error('Failed to authenticate passkey.');
  return Object.freeze({ credentialId: idOf(credential) });
}

function credentialsApi(): CredentialsContainer {
  const credentials = globalThis.navigator?.credentials;
  if (!credentials)
    throw protocolError('WEBAUTHN_UNAVAILABLE', 'WebAuthn is not supported in this environment.');
  return credentials;
}

const idOf = (credential: PublicKeyCredential) => base64UrlEncode(new Uint8Array(credential.rawId));
