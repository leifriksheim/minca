/**
 * What the docs' examples take as given, the way Vue's guide takes `app`.
 * scripts/check-examples.mjs type-checks every example with these in scope.
 * Keep the list short: an example that needs anything else imports it or
 * makes it.
 */
import * as z from 'zod';
import { collection, type NodeRecord, type P2PNode, type SpaceSummary } from '@minca/core';
import type { MincaConnection } from '@minca/core/session';

/** The to-do collection from "Building an app" */
const todoCollection = collection({
  name: 'app.todo.item',
  title: 'To-do',
  schema: z.object({ text: z.string().min(1), done: z.boolean() }),
});

declare global {
  /** The node the app reads and writes through: `useNode()` in React */
  const node: P2PNode;
  /** A space the app was given */
  const space: SpaceSummary;
  /** The to-do collection from "Building an app" */
  const todos: typeof todoCollection;
  /** A to-do */
  const todo: NodeRecord<{ text: string; done: boolean }>;
  /** Someone's account DID */
  const did: string;
  /** The element the app renders into */
  const root: HTMLElement;
  /** The app's connection to the account home, from "Building an app" */
  const connection: MincaConnection;
}
