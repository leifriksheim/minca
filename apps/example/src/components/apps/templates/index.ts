/**
 * The ready-made apps: each an ordinary app with a screen (`screens.ts`),
 * written the way an agent would write one, and copied into a space when
 * someone adds it (`addTemplate` in `launcher.ts`).
 */
import {
  ballot,
  call,
  column,
  comment,
  decision,
  event,
  file,
  list,
  listItem,
  listing,
  message,
  notifyOn,
  order,
  orderUpdate,
  poll,
  positionBetween,
  proposal,
  rsvp,
  task,
  vote,
} from '@minca/core/schemas';
import type { Template } from '../launcher';
import calls from './calls.html?raw';
import chat from './chat.html?raw';
import decisions from './decisions.html?raw';
import events from './events.html?raw';
import files from './files.html?raw';
import kanban from './kanban.html?raw';
import marketplace from './marketplace.html?raw';
import polls from './polls.html?raw';

export const TEMPLATES: ReadonlyArray<Template> = [
  {
    app: {
      template: 'chat',
      title: 'Chat',
      description:
        'Talk with everyone in the space. "@" someone to tell them, and drop files in to share them.',
      collections: [message.name, file.name],
      shows: [message.name],
      notify: [
        notifyOn('Mentions me', message.name, { mentions: { $contains: '$me' } }),
        notifyOn('New message', message.name),
      ],
      screen: chat,
    },
    needs: [message, file],
  },
  {
    app: {
      template: 'files',
      title: 'Files',
      description:
        'Every file shared in the space, from chats and boards alike: by kind, size and name, and in categories of your own.',
      collections: [file.name, list.name, listItem.name],
      shows: [file.name],
      screen: files,
    },
    needs: [file, list, listItem],
  },
  {
    app: {
      template: 'kanban',
      title: 'Kanban',
      description: 'Tasks on a board: drag them between columns, and into order.',
      collections: [task.name, column.name],
      notify: [
        notifyOn('New task', task.name),
        notifyOn('Assigned to me', task.name, { assignees: { $contains: '$me' } }),
      ],
      screen: kanban,
    },
    needs: [task, column],
    uses: [file],
    setup: async (node, spaceId) => {
      if ((await node.records.list(spaceId, { collection: column.name })).length > 0) return;
      let position: string | null = null;
      for (const name of ['To do', 'Doing', 'Done']) {
        position = positionBetween(position);
        await node.records.put(spaceId, column.name, { name, position });
      }
    },
  },
  {
    app: {
      template: 'polls',
      title: 'Polls',
      description: 'Ask the space a question. Everyone picks one option, and can change their mind.',
      collections: [poll.name, vote.name],
      notify: [
        notifyOn('New poll', poll.name),
        notifyOn('Votes on my polls', vote.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: polls,
    },
    needs: [poll, vote],
  },
  {
    app: {
      template: 'decisions',
      title: 'Decisions',
      description:
        'Put something to the space, and decide it once enough people agree. Every device checks the count.',
      collections: [proposal.name, ballot.name, decision.name],
      notify: [
        notifyOn('New proposal', proposal.name),
        notifyOn('Decided', decision.name),
        notifyOn('Ballots on my proposals', ballot.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: decisions,
    },
    needs: [proposal, ballot, decision],
  },
  {
    app: {
      template: 'events',
      title: 'Events',
      description: "Concerts, meetups, parties: what's on, who's going, and a place to talk about each one.",
      collections: [event.name, rsvp.name, comment.name],
      notify: [
        notifyOn('New event', event.name),
        notifyOn('Answers to my events', rsvp.name, { respondingTo: { $contains: '$me' } }),
        notifyOn('Comments on my events', comment.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: events,
    },
    needs: [event, rsvp, comment],
  },
  {
    app: {
      template: 'marketplace',
      title: 'Marketplace',
      description: 'Sell, give away and find things among the people in the space.',
      collections: [listing.name, order.name, orderUpdate.name, comment.name],
      notify: [
        notifyOn('New listing', listing.name),
        notifyOn('Requests for my things', order.name, { respondingTo: { $contains: '$me' } }),
        notifyOn('Answers to my requests', orderUpdate.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: marketplace,
    },
    needs: [listing, order, orderUpdate, comment],
  },
  {
    app: {
      template: 'calls',
      title: 'Calls',
      description: 'Keeps a log of the calls in this space: who was in each, and calls nobody answered.',
      collections: [call.name],
      screen: calls,
    },
    needs: [call],
  },
];
