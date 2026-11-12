/**
 * @module inbox
 * The inbox and knocks — see `inbox.ts`, and `node.inbox` for the API an app uses.
 */
export { encodeInbox, readInbox } from './inbox.js';
export type { InboxBody } from './inbox.js';
export {
  parseUsername,
  formatUsername,
  usernameUrl,
  resolveUsername,
  claimUsername,
  usernameIdeas,
  usernameFree,
  adHocName,
  nameFromUsername,
} from './names.js';
export type { Username, ResolvedUsername } from './names.js';

export type { MailboxClient, MailItem } from '../network/relays.js';
