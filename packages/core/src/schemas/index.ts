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
export {
  automation,
  automationRun,
  activity,
  ACTIVITY_STATES,
  ACTIVITY_STALE_SECONDS,
  activeNow,
  setActivity,
  IT,
  ME,
  asRunner,
  INSTRUCT,
  checkAutomation,
  automationOf,
  matching,
  act,
  runAutomations,
  startAutomations,
  automationsFor,
  suggestedAutomations,
  fillAutomationText,
} from './automations.js';
export type {
  ActiveAutomation,
  Automation,
  AutomationAction,
  AutomationLink,
  AutomationMatch,
  AutomationRun,
  AutomationApp,
  AutomationSpaces,
  Activity,
  ActivityState,
  AutomationTrigger,
  AutomationWhen,
  AutomationNotifier,
  RunAutomationsOptions,
  StartAutomationsOptions,
} from './automations.js';
export {
  connect,
  connector,
  CONNECT_REQUEST_SECONDS,
  askToConnect,
  askToDisconnect,
  connectPage,
  botSettings,
  BOT_INSTRUCTIONS_MAX,
  mayConfigure,
  holdsBotRoles,
} from './connectors.js';
export type { BotSettings, Connect, ConnectAsk, Connector } from './connectors.js';
export { checkCron, cronMatches, SCHEDULES } from './cron.js';
export { notifyOn, namesTheRunner } from '../space/own-automations.js';
export type { AppAutomation } from '../space/own-automations.js';
