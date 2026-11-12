/**
 * The collections the node itself reads and writes, and the pieces
 * definitions are built from. The standard library of record shapes apps
 * share is `@minca/std`.
 */
/** The pieces the definitions are built from — a time, money, a place, a file — for definitions of your own */
export * as fragments from './fragments.js';
export type { Money, Address, Place, BlobRef, ImageRef } from './fragments.js';
export { definedIn, definedNames } from './defined.js';
export { direct } from './direct.js';
export type { Direct } from './direct.js';
export { contact, contactRequest, inbox, knock, spaceInvite } from './contacts.js';
export type { Contact, ContactRequestRecord, Inbox, Knock, SpaceInviteRecord } from './contacts.js';
export { notifyOn, ME, asRunner } from '../space/own-automations.js';
export type { AppAutomation, AutomationApp, AutomationSpaces } from '../space/own-automations.js';
