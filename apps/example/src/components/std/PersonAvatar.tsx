import { useProfiles } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { useFileUrl } from '../../files';

/** Someone's avatar in a space: the picture they chose, once it is here, or the shape their account gives */
export function PersonAvatar({ spaceId, did, size = 32 }: { spaceId: string; did: string; size?: number }) {
  const avatar = useProfiles(spaceId).find((profile) => profile.did === did)?.avatar;
  return <Avatar did={did} size={size} src={useFileUrl(spaceId, avatar)} />;
}
