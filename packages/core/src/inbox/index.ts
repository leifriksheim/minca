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
  MAIL_COLLECTION,
  KNOCK_DROP_WINDOW_SECONDS,
  MAX_INBOX_PLACES,
  KNOCK_TTL_SECONDS,
} from './inbox.js';
export type { InboxBody, KnockBody, OpenedKnock } from './inbox.js';
export { createMailboxClient } from '../network/mailbox.js';
export type { MailboxClient, MailboxOptions, MailItem } from '../network/mailbox.js';
