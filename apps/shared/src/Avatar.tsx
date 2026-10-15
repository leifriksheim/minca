import { avatarShape } from './avatar';

/**
 * A visual fingerprint for an account.
 *
 * Derived from the DID, so it is the same everywhere the account appears and
 * needs nothing stored. The point is recognition rather than decoration: with
 * several accounts in one folder, a wrong one should be obvious before you have
 * read the name.
 */
export function Avatar({ did, size = 32 }: { did: string; size?: number }) {
  const { d, fill, ground } = avatarShape(did);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Account avatar"
      style={{ borderRadius: size / 4, background: ground, flexShrink: 0, display: 'block' }}
    >
      <path d={d} fill={fill} />
    </svg>
  );
}
