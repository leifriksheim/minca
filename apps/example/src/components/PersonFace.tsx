import { Avatar } from '@minca/app-shared/Avatar';
import { useFileUrl } from '../files';
import { usePictureAt } from '../pictures';

/** Someone's face wherever they appear: the picture their account has, or the shape their account gives */
export function PersonFace({ did, size = 32, round }: { did: string; size?: number; round?: boolean }) {
  const at = usePictureAt(did);
  return <Avatar did={did} size={size} round={round} src={useFileUrl(at?.spaceId ?? '', at?.avatar)} />;
}
