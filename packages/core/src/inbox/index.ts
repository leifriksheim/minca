/**
 * @module inbox
 * The inbox and knocks — see `inbox.ts`, and `node.inbox` for the API an app uses.
 */
export {
  encodeInbox,
  readInbox,
  inboxProblem,
  inboxAuthor,
  inboxTopic,
  knockId,
  sealKnock,
  openKnock,
  signPurge,
  purgeMessage,
  clip,
  INBOX_COLLECTION,
  KNOCK_COLLECTION,
  MAX_INBOX_PLACES,
  KNOCK_TTL_SECONDS,
} from './inbox.js';
export type { InboxBody, KnockBody, OpenedKnock } from './inbox.js';
export {
  parseUsername,
  formatUsername,
  usernameUrl,
  resolveUsername,
  claimUsername,
  claimMessage,
  bindMessage,
} from './names.js';
export type { Username, ResolvedUsername } from './names.js';
export { createMailboxClient } from '../network/relays.js';
export type { MailboxClient, MailboxOptions, MailItem } from '../network/relays.js';
