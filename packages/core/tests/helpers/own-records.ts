/**
 * A constitution for tests where members change only what they made: what
 * a collection's `edit: 'creator'` rule used to say, now a grant (spec 03 §2).
 */
import type { SpaceRole } from '../../src/types.js';
import { COLLECTION_DEFINE, RECORD_DELETE, RECORD_WRITE, ROLE_ASSIGN } from '../../src/space/grants.js';

/** Writing and deleting only one's own records */
export const OWN = Object.freeze([
  { cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] },
  { cmd: RECORD_DELETE, pol: [['==', '.byCreator', true]] },
]);

/** Editors change only their own records, define collections, and invite more editors */
export const ownRecords: { readonly roles: ReadonlyArray<SpaceRole> } = Object.freeze({
  roles: [
    {
      name: 'editor',
      title: 'Editor',
      grants: [
        ...OWN,
        { cmd: COLLECTION_DEFINE, pol: [] },
        { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'editor']] },
      ],
    },
  ],
});
