/**
 * Everyone's picture, wherever they appear. A picture is the account's: its node copies it into each
 * space the account is in, so any copy is theirs, and the copy on their newest profile is the one they
 * have now. One lookup for the whole app, given by `App` (`Pictures`), so a contact shows the same face
 * as they do in a group you share.
 */
import { createContext, useContext } from 'react';
import { useWatched } from '@minca/react';
import type { FileRef, SpaceSummary } from '@minca/core';

/** Where someone's picture is: the space with their newest profile, and its picture there, if any */
export interface PictureAt {
  readonly spaceId: string;
  readonly avatar?: FileRef | undefined;
  readonly updatedAt: string;
}

const NONE: ReadonlyMap<string, PictureAt> = new Map();

/** The lookup, for every page under `App` */
export const Pictures = createContext<ReadonlyMap<string, PictureAt>>(NONE);

/** Where someone's picture is, by their account */
export const usePictureAt = (did: string): PictureAt | undefined => useContext(Pictures).get(did);

/** Each person's newest profile across these spaces, by account; read again as records arrive */
export function usePictures(spaces: ReadonlyArray<SpaceSummary>): ReadonlyMap<string, PictureAt> {
  const ids = spaces.map((space) => space.id);
  const found = useWatched(
    async (node) => {
      const newest = new Map<string, PictureAt>();
      for (const spaceId of ids)
        for (const profile of await node.spaces.profiles(spaceId).catch(() => [])) {
          const held = newest.get(profile.did);
          if (!held || profile.updatedAt > held.updatedAt)
            newest.set(profile.did, { spaceId, avatar: profile.avatar, updatedAt: profile.updatedAt });
        }
      return newest;
    },
    [ids.join(',')],
    { when: (event) => event.type === 'records' || event.type === 'spaces', settle: 500 },
  );
  return found ?? NONE;
}
