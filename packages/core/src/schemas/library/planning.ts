/**
 * Time and planning: calendars, events and RSVPs, bookable slots, tasks on a
 * board, projects, time tracking, reminders, habits.
 */
import {
  about,
  choice,
  count,
  day,
  markdown,
  one,
  people,
  placeRef,
  position,
  text,
  timeZone,
  define,
  url,
  when,
  words,
  person,
} from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/** A calendar that events are `in`. */
export const calendar = define({
  name: 'std.calendar',
  title: 'Calendar',
  description: 'A calendar of events.',
  schema: {
    type: 'object',
    properties: { name: words(200), color: text(32) },
    required: ['name'],
  },
});
export type Calendar = BodyOf<typeof calendar>;

/**
 * Something happening at a time, after JSCalendar (RFC 8984). `start` and
 * `end` are RFC 3339 with `tz` saying where the times are meant, or whole days
 * (`YYYY-MM-DD`) with `allDay`. `rrule` repeats it (RFC 5545).
 */
export const event = define({
  name: 'std.event',
  title: 'Event',
  description: 'Something happening at a time and place.',
  schema: {
    type: 'object',
    properties: {
      title: words(500),
      description: markdown(10000),
      category: text(100, 'Like "music", "meetup" or "sports"'),
      start: when(),
      end: when(),
      tz: timeZone(),
      allDay: { type: 'boolean' },
      place: placeRef(),
      url: url(),
      rrule: text(1000, 'RFC 5545 recurrence rule, like "FREQ=WEEKLY;BYDAY=TU"', 1),
      status: choice(['confirmed', 'tentative', 'cancelled']),
    },
    required: ['title', 'start'],
  },
  links: { in: one(['std.calendar'], 'The calendar it is in') },
  topics: ['place.cells'],
});
export type CalendarEvent = BodyOf<typeof event>;

/** Whether someone is coming: one per person per event, changed by answering again. */
export const rsvp = define({
  name: 'std.rsvp',
  title: 'RSVP',
  description: 'Whether someone is coming to an event: one answer per person.',
  schema: {
    type: 'object',
    properties: {
      respondingTo: person('Whose record it responds to, so they can be told'),
      status: choice(['going', 'maybe', 'no']),
      guests: count(0, 100, 'People they bring along'),
      note: text(500),
    },
    required: ['status'],
  },
  links: { about: one(['std.event'], 'The event') },
  rules: { onePer: ['@author', 'link:about'] },
  topics: ['respondingTo'],
});
export type Rsvp = BodyOf<typeof rsvp>;

/** A time that can be booked. Bookings are `about` it, one each. */
export const slot = define({
  name: 'std.slot',
  title: 'Slot',
  description: 'A time one person can book, by a std.claim about it.',
  schema: {
    type: 'object',
    properties: { start: when(), end: when(), tz: timeZone(), note: text(1000) },
    required: ['start', 'end'],
  },
  links: { in: one(['std.calendar'], 'The calendar it is in') },
});
export type Slot = BodyOf<typeof slot>;

/** A column on a board — To do, Doing, Done — in the order it sits. */
export const column = define({
  name: 'std.column',
  title: 'Column',
  description:
    'A column on a task board (To do, Doing, Done), in a std.project or on its own; tasks sit in it.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      position: { type: 'string', minLength: 1, maxLength: 200, description: 'Sorts where the column goes' },
    },
    required: ['name'],
  },
  links: { in: one(['std.project'], 'The project whose board it is on') },
});
export type Column = BodyOf<typeof column>;

const TASK_STATUS = ['todo', 'doing', 'done', 'cancelled'] as const;

/**
 * A task: `in` a column of a board, or in a project with no columns, and
 * under a parent task. `status` is for lists without columns; a board's
 * column says where the task is.
 * `assignees` is its topic, so "assigned to me" can be asked of a keeper that
 * can't read it.
 */
export const task = define({
  name: 'std.task',
  title: 'Task',
  description:
    'A thing to do: a to-do, an issue, a card on a board. `status` for plain lists; on a board it sits in a std.column. Something to be reminded of about an existing record is a std.reminder.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      notes: { type: 'string', maxLength: 10000 },
      position: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Sorts where the task goes in its column',
      },
      due: when(),
      status: choice(TASK_STATUS),
      assignees: people(20, 'Who is doing it'),
      priority: count(0, 4, '0 none, 1 urgent, 2 high, 3 medium, 4 low'),
    },
    required: ['title'],
  },
  topics: ['assignees'],
  links: {
    in: one(
      ['std.column', 'std.project'],
      'The board column it sits in, or the project when it has no columns',
    ),
    parent: one(['std.task'], 'The task it is part of'),
  },
});
export type Task = BodyOf<typeof task>;

/** A project that tasks belong to. */
export const project = define({
  name: 'std.project',
  title: 'Project',
  description: 'A project that tasks and board columns are in.',
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      description: markdown(10000),
      status: choice(['planned', 'active', 'paused', 'done', 'cancelled']),
      due: when(),
    },
    required: ['name'],
  },
});
export type Project = BodyOf<typeof project>;

/** Time spent on something; running while it has no `end`. */
export const timeEntry = define({
  name: 'std.time-entry',
  title: 'Time entry',
  description: 'Time someone spent on something.',
  schema: {
    type: 'object',
    properties: { start: when(), end: when(), note: text(1000) },
    required: ['start'],
  },
  links: { about: about('What the time was spent on') },
});
export type TimeEntry = BodyOf<typeof timeEntry>;

/** A reminder for its author. Keep it in your own space. */
export const reminder = define({
  name: 'std.reminder',
  title: 'Reminder',
  description:
    'A nudge at a time about an existing record (about), for its author. A thing to do is a std.task with `due`.',
  schema: {
    type: 'object',
    properties: { at: when(), note: text(1000), done: { type: 'boolean' } },
    required: ['at'],
  },
  links: { about: about('What it is about') },
});
export type Reminder = BodyOf<typeof reminder>;

/** A habit to keep. Check-ins are `about` it. */
export const habit = define({
  name: 'std.habit',
  title: 'Habit',
  description: 'Something to do regularly.',
  schema: {
    type: 'object',
    properties: {
      name: words(200),
      schedule: text(1000, 'RFC 5545 recurrence rule, like "FREQ=DAILY"'),
      target: { type: 'number', minimum: 0, description: 'How much a day counts as done' },
      unit: text(32),
      position: position(),
    },
    required: ['name'],
  },
});
export type Habit = BodyOf<typeof habit>;

/** Doing a habit on a day: one per person per habit per day. */
export const checkin = define({
  name: 'std.checkin',
  title: 'Check-in',
  description: 'A habit done on a day: one per person per day.',
  schema: {
    type: 'object',
    properties: { date: day(), value: { type: 'number' }, note: text(1000) },
    required: ['date'],
  },
  links: { about: one(['std.habit'], 'The habit') },
  rules: { onePer: ['@author', 'link:about', 'date'] },
});
export type Checkin = BodyOf<typeof checkin>;

/** This file's part of `standardGroups` */
export const planningGroups = {
  'Time and planning': [
    calendar,
    event,
    rsvp,
    slot,
    column,
    task,
    project,
    timeEntry,
    reminder,
    habit,
    checkin,
  ],
};
