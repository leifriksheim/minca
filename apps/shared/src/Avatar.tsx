import { avatarFit, avatarRadius, avatarShape } from './avatar';

/**
 * A visual fingerprint for an account.
 *
 * Derived from the DID, so it is the same everywhere the account appears and
 * needs nothing stored. The point is recognition rather than decoration: with
 * several accounts in one folder, a wrong one should be obvious before you have
 * read the name.
 *
 * A rounded square on its own, in a card or a list; round inside something
 * round already (a pill button, an account picker), where corners would
 * fight the shape around it.
 */
export function Avatar({ did, size = 32, round = false }: { did: string; size?: number; round?: boolean }) {
  const { d, fill, ground } = avatarShape(did);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Account avatar"
      style={{ borderRadius: avatarRadius(size, round), background: ground, flexShrink: 0, display: 'block' }}
    >
      <path d={d} fill={fill} transform={avatarFit(round)} />
    </svg>
  );
}
