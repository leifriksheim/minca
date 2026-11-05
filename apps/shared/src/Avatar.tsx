import { avatarFit, avatarRadius, avatarShape } from '@minca/ui/avatar';
import { rememberedPicture } from './rememberedPictures';
import styles from './Avatar.module.css';

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
 *
 * The picture the person chose takes its place: `src`, or else the one this
 * browser remembers for the account. A picture carries the shape small on its
 * corner: anyone can copy a picture, but not the shape, so two accounts with
 * one face still differ.
 */
export function Avatar({
  did,
  size = 32,
  round = false,
  src,
}: {
  did: string;
  size?: number;
  round?: boolean;
  /** A picture the person chose; left out, the one this browser remembers, if any */
  src?: string | null;
}) {
  const picture = src ?? rememberedPicture(did);
  if (!picture) return <Shape did={did} size={size} round={round} />;
  // Too small to carry a mark that can still be told apart
  const badge = size >= 28 ? Math.round(size * 0.38) : 0;
  return (
    <span className={styles.face}>
      <img
        src={picture}
        width={size}
        height={size}
        alt="Account avatar"
        className={styles.avatar}
        // eslint-disable-next-line react/forbid-dom-props -- the corner comes from the size
        style={{ borderRadius: avatarRadius(size, round) }}
      />
      {badge > 0 && <Shape did={did} size={badge} round badge />}
    </span>
  );
}

function Shape({
  did,
  size,
  round,
  badge = false,
}: {
  did: string;
  size: number;
  round: boolean;
  badge?: boolean;
}) {
  const { d, fill, ground } = avatarShape(did);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={badge ? undefined : 'img'}
      aria-hidden={badge || undefined}
      aria-label={badge ? undefined : 'Account avatar'}
      className={badge ? styles.badge : styles.avatar}
      // eslint-disable-next-line react/forbid-dom-props -- the corner and ground come from the account
      style={{ borderRadius: avatarRadius(size, round), background: ground }}
    >
      <path d={d} fill={fill} transform={avatarFit(round)} />
    </svg>
  );
}
