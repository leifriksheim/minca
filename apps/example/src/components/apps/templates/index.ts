/**
 * The ready-made apps: each an ordinary app with a screen (`screens.ts`),
 * written the way an agent would write one, and copied into a space when
 * someone adds it (`addTemplate` in `launcher.ts`). Two have no screen and are
 * drawn by the app itself: direct messages (`DirectMessages.tsx`), since a
 * screen must never be handed text sealed for its viewer alone, and Sheets
 * (`Sheets.tsx`), since it shows every collection and a screen sees only its own.
 */
import { direct, notifyOn } from '@minca/core/schemas';
import {
  column,
  comment,
  event,
  expense,
  file,
  list,
  listItem,
  listing,
  message,
  order,
  orderUpdate,
  poll,
  positionBetween,
  reaction,
  rsvp,
  settlement,
  task,
  vote,
} from '@minca/std';
import { DIRECT, type Template } from '../launcher';
import { SHEETS, sheetView } from '../../sheets/views';
import bills from './bills.html?raw';
import chat from './chat.html?raw';
import events from './events.html?raw';
import files from './files.html?raw';
import kanban from './kanban.html?raw';
import lists from './lists.html?raw';
import marketplace from './marketplace.html?raw';
import polls from './polls.html?raw';

export const TEMPLATES: ReadonlyArray<Template> = [
  {
    app: {
      template: 'chat',
      title: 'Chat',
      description:
        'Talk with everyone in the space: reply, react, "@" someone to tell them, drop files in to share them, and send GIFs.',
      collections: [message.name, file.name, reaction.name],
      shows: [message.name],
      notify: [
        notifyOn('Mentions me', message.name, { mentions: { $contains: '$me' } }),
        notifyOn('Replies to me', message.name, { replyingTo: '$me' }),
        notifyOn('New message', message.name),
      ],
      screen: chat,
      network: ['https://api.giphy.com', 'https://media.giphy.com'],
      settings: [
        {
          key: 'giphy',
          title: 'GIPHY API key',
          description:
            'For GIFs in the chat. Make a free one at developers.giphy.com, under Create an API key. Without it there are no GIFs.',
        },
      ],
    },
    needs: [message, file, reaction],
  },
  {
    app: {
      template: DIRECT,
      title: 'Direct messages',
      description:
        'Write to one or a few people in the group, sealed for them: the rest see that you wrote, not what.',
      collections: [direct.name],
      shows: [direct.name],
      notify: [notifyOn('Messages to me', direct.name, { to: { $contains: '$me' } })],
    },
    needs: [direct],
  },
  {
    app: {
      template: 'files',
      title: 'Files',
      description:
        'Every file shared in the space, from chats and boards alike: by kind, size and name, and in categories of your own.',
      collections: [file.name, list.name, listItem.name],
      shows: [file.name, `${list.name}:category`, `${list.name}:folder`, `${list.name}:album`],
      screen: files,
    },
    needs: [file, list, listItem],
  },
  {
    app: {
      template: 'kanban',
      title: 'Kanban',
      description:
        'Cards on a board, like Trello: drag them between columns, put people on them, give them a due date and a checklist.',
      collections: [task.name, column.name, comment.name, file.name],
      shows: [task.name],
      notify: [
        notifyOn('New task', task.name),
        notifyOn('Assigned to me', task.name, { assignees: { $contains: '$me' } }),
      ],
      screen: kanban,
    },
    needs: [task, column, comment, file],
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
      template: 'lists',
      title: 'Lists',
      description: 'To-dos, groceries, packing: lists everyone in the group can tick and add to.',
      collections: [list.name, listItem.name],
      shows: [list.name],
      notify: [notifyOn('New list', list.name)],
      screen: lists,
    },
    needs: [list, listItem],
  },
  {
    app: {
      template: 'bills',
      title: 'Bills',
      description:
        'Split what you spend together, on a tab for each trip, flat or dinner, and settle up in as few payments as can be.',
      collections: [expense.name, settlement.name, comment.name, list.name, listItem.name],
      shows: [expense.name, `${list.name}:tab`],
      notify: [
        notifyOn('Expenses I owe a part of', expense.name, { owedBy: { $contains: '$me' } }),
        notifyOn('Paid back to me', settlement.name, { to: '$me' }),
      ],
      screen: bills,
    },
    needs: [expense, settlement, comment, list, listItem],
  },
  {
    app: {
      template: SHEETS,
      title: 'Sheets',
      description:
        'Every collection in the space as a table, a board, cards or a list: change cells in place, save views for everyone, and make collections of your own.',
      collections: [sheetView.name],
    },
    needs: [sheetView],
  },
  {
    app: {
      template: 'polls',
      title: 'Polls',
      description: 'Ask the space a question. Everyone picks one option, and can change their mind.',
      collections: [poll.name, vote.name],
      shows: [poll.name],
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
      template: 'events',
      title: 'Events',
      description: "Concerts, meetups, parties: what's on, who's going, and a place to talk about each one.",
      collections: [event.name, rsvp.name, comment.name, file.name],
      shows: [event.name],
      notify: [
        notifyOn('New event', event.name),
        notifyOn('Answers to my events', rsvp.name, { respondingTo: { $contains: '$me' } }),
        notifyOn('Comments on my events', comment.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: events,
    },
    needs: [event, rsvp, comment, file],
  },
  {
    app: {
      template: 'marketplace',
      title: 'Marketplace',
      description: 'Sell, give away and find things among the people in the space.',
      collections: [listing.name, order.name, orderUpdate.name, comment.name],
      shows: [listing.name],
      notify: [
        notifyOn('New listing', listing.name),
        notifyOn('Requests for my things', order.name, { respondingTo: { $contains: '$me' } }),
        notifyOn('Answers to my requests', orderUpdate.name, { respondingTo: { $contains: '$me' } }),
      ],
      screen: marketplace,
    },
    needs: [listing, order, orderUpdate, comment],
  },
];
