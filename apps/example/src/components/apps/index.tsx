import type { ComponentType } from 'react';
import type { DefineCollection, NodeCollection, NodeRecord, P2PNode, SpaceSummary } from '@minca/core';
import {
  attachment,
  ballot,
  call,
  channel,
  column,
  comment,
  decision,
  direct,
  event,
  listing,
  message,
  order,
  orderUpdate,
  poll,
  proposal,
  reaction,
  rsvp,
  task,
  vote,
  positionBetween,
} from '@minca/core/schemas';
import { CallHistory } from './CallHistory';
import { Chat } from './Chat';
import { Decisions } from './Decisions';
import { Events } from './Events';
import { Kanban } from './Kanban';
import { Marketplace } from './Marketplace';
import { Polls } from './Polls';
import { notifyOn, type AppAutomation } from '@minca/core/schemas';
import type { Glyph } from '../Icon';
import type { MiniApp } from '@minca/app-shared/mini-app';
import { liquid } from './liquid/mini-app';

export interface AppProps {
  readonly space: SpaceSummary;
  readonly collections: ReadonlyArray<NodeCollection>;
  readonly onOpen: (record: NodeRecord) => void;
  /** When the person last looked at this app, so it can mark what arrived since (`seen.ts`) */
  readonly since?: string;
}

/** An app: a screen that knows some standard schemas, shown wherever a space has them. */
export interface MincaApp {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** How its tile looks: a glyph on a tint of this hue */
  readonly icon: Glyph;
  readonly hue: number;
  /** What in it is worth hearing about: offered as notifications, and counted as new */
  readonly notify: ReadonlyArray<AppAutomation>;
  /** Takes the whole window when open, the way a conversation does */
  readonly fill?: boolean;
  /** Without these it cannot work: adding the app defines the missing ones */
  readonly needs: ReadonlyArray<DefineCollection>;
  /** Shown when the space has them, left out when it does not */
  readonly uses?: ReadonlyArray<DefineCollection>;
  /** Runs once, right after someone adds the app — a board's first columns */
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
  readonly View: ComponentType<AppProps>;
}

/**
 * A mini app (`@minca/app-shared/mini-app`) as one of ours: the same code
 * that runs as its own site, in a space's frame here. It brings its own
 * stylesheet, put in the page the first time it is shown.
 */
function fromMiniApp(app: MiniApp): MincaApp {
  const Space = app.Space;
  return {
    id: app.id,
    title: app.title,
    description: app.description,
    icon: { path: app.icon },
    hue: app.hue,
    notify: app.notify ?? [],
    needs: app.needs,
    ...(app.setup ? { setup: app.setup } : {}),
    View: ({ space }) => {
      app.injectStyles?.();
      return <Space space={space} />;
    },
  };
}

export const APPS: ReadonlyArray<MincaApp> = [
  {
    id: 'chat',
    icon: 'chat',
    hue: 212,
    notify: [
      notifyOn('Mentions me', message.name, { mentions: { $contains: '$me' } }),
      notifyOn('Replies to me', message.name, { replyingTo: { $contains: '$me' } }),
      notifyOn('Direct message to me', direct.name, { to: { $contains: '$me' } }),
      notifyOn('New message', message.name),
      notifyOn('Reactions to what I wrote', reaction.name, { respondingTo: { $contains: '$me' } }),
    ],
    fill: true,
    title: 'Chat',
    description:
      'Talk with everyone in the space, in channels, or directly with one person: only the two of you can read it.',
    needs: [message],
    uses: [reaction, channel, direct, attachment],
    View: Chat,
  },
  {
    id: 'kanban',
    icon: 'board',
    hue: 28,
    notify: [
      notifyOn('New task', task.name),
      notifyOn('Assigned to me', task.name, { assignees: { $contains: '$me' } }),
    ],
    title: 'Kanban',
    description: 'Tasks on a board: drag them between columns, and into order.',
    needs: [task, column],
    uses: [attachment],
    setup: async (node, spaceId) => {
      if ((await node.records.list(spaceId, { collection: column.name })).length > 0) return;
      let position: string | null = null;
      for (const name of ['To do', 'Doing', 'Done']) {
        position = positionBetween(position);
        await node.records.put(spaceId, column.name, { name, position });
      }
    },
    View: Kanban,
  },
  {
    id: 'polls',
    icon: 'poll',
    hue: 268,
    notify: [
      notifyOn('New poll', poll.name),
      notifyOn('Votes on my polls', vote.name, { respondingTo: { $contains: '$me' } }),
    ],
    title: 'Polls',
    description: 'Ask the space a question. Everyone picks one option, and can change their mind.',
    needs: [poll, vote],
    View: Polls,
  },
  {
    id: 'decisions',
    icon: 'decide',
    hue: 118,
    notify: [
      notifyOn('New proposal', proposal.name),
      notifyOn('Decided', decision.name),
      notifyOn('Ballots on my proposals', ballot.name, { respondingTo: { $contains: '$me' } }),
    ],
    title: 'Decisions',
    description:
      'Put something to the space, and decide it once enough people agree. Every device checks the count.',
    needs: [proposal, ballot, decision],
    View: Decisions,
  },
  {
    id: 'events',
    icon: 'calendar',
    hue: 352,
    notify: [
      notifyOn('New event', event.name),
      notifyOn('Answers to my events', rsvp.name, { respondingTo: { $contains: '$me' } }),
      notifyOn('Comments on my events', comment.name, { respondingTo: { $contains: '$me' } }),
    ],
    title: 'Events',
    description: "Concerts, meetups, parties: what's on, who's going, and a place to talk about each one.",
    needs: [event, rsvp, comment],
    View: Events,
  },
  {
    id: 'marketplace',
    icon: 'tag',
    hue: 196,
    notify: [
      notifyOn('New listing', listing.name),
      notifyOn('Requests for my things', order.name, { respondingTo: { $contains: '$me' } }),
      notifyOn('Answers to my requests', orderUpdate.name, { respondingTo: { $contains: '$me' } }),
    ],
    title: 'Marketplace',
    description: 'Sell, give away and find things among the people in the space.',
    needs: [listing, order, orderUpdate, comment],
    View: Marketplace,
  },
  fromMiniApp(liquid),
  {
    id: 'calls',
    icon: 'phone',
    hue: 150,
    notify: [],
    title: 'Calls',
    description: 'Keeps a log of the calls in this space: who was in each, and calls nobody answered.',
    needs: [call],
    View: CallHistory,
  },
];

/** Whether the space has defined a collection */
export const has = (collections: ReadonlyArray<NodeCollection>, name: string) =>
  collections.some((c) => c.name === name && c.version !== null);
