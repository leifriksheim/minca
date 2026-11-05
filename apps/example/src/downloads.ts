/**
 * What the app downloads of others' files before anyone opens them, and how
 * much it keeps per space: chosen once for the account (`accountSetting`), and
 * given to the node each time it starts (`node.setFileLimits`), as the node
 * keeps none.
 */
import { useEffect } from 'react';
import { DEVICE_LIMITS, type FileLimits } from '@minca/core';
import { useNode } from '@minca/react';
import { accountSetting, fieldOf } from '@minca/app-shared/setting';

const MB = 1024 * 1024;

export type Ahead = 'thumbnails' | 'photos' | 'everything';
export type Keep = '256' | '1024' | '4096';

interface Downloads {
  readonly ahead: Ahead;
  readonly keep: Keep;
}

/** The largest file fetched before it is opened: one chunk, which every thumbnail fits; a device's default; any */
const AHEAD_BYTES: Readonly<Record<Ahead, number>> = {
  thumbnails: 256 * 1024,
  photos: DEVICE_LIMITS.ahead,
  everything: Infinity,
};

const AHEAD = Object.keys(AHEAD_BYTES);
const KEEP = ['256', '1024', '4096'];

const downloads = accountSetting({
  name: 'minca.downloads',
  title: 'Downloads',
  schema: {
    type: 'object',
    properties: { ahead: { enum: AHEAD }, keep: { enum: KEEP } },
    required: ['ahead', 'keep'],
  },
  valid: (body): body is Downloads =>
    AHEAD.includes(String(fieldOf(body, 'ahead'))) && KEEP.includes(String(fieldOf(body, 'keep'))),
  fallback: { ahead: 'photos', keep: '256' },
});

/** The account's choice, and the way to change it */
export const useDownloads = downloads.use;

/** The node's limits for a choice */
const limitsOf = (chosen: Downloads): FileLimits => ({
  ahead: AHEAD_BYTES[chosen.ahead],
  keep: Number(chosen.keep) * MB,
});

/** Gives the node the account's choice when it starts, and again whenever it changes */
export function useApplyDownloads(): void {
  const node = useNode();
  const [chosen] = useDownloads();
  useEffect(() => {
    void node.setFileLimits(limitsOf(chosen)).catch(() => {
      // A node from before limits could be set: it keeps its own.
    });
  }, [node, chosen]);
}
