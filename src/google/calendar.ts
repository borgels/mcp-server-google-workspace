import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { hasOffset, isDate, nextDay, withSeconds } from './values.js';

/**
 * Google Calendar API v3 (https://developers.google.com/workspace/calendar/api/v3/reference). Answers are cut down
 * to the fields a person reads; a change never sends invitations or updates by mail (sendUpdates=none).
 */

type Json = Record<string, unknown>;

/**
 * A calendar id as one path segment. The schema admits only letters, digits and `_@.#+-`; `#` (in Google's own
 * calendars, such as holidays) is percent-encoded, and an id of dots only is refused, so it cannot be a dot segment.
 */
export function calendarPath(id: string): string {
  if (!/^[A-Za-z0-9_@.#+-]{1,320}$/.test(id) || /^\.+$/.test(id)) throw new Error('Invalid calendarId.');
  return encodeURIComponent(id);
}

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function when(value: unknown): Json | undefined {
  const v = obj(value);
  if (str(v.date)) return { date: v.date };
  if (str(v.dateTime)) return { dateTime: v.dateTime, ...(str(v.timeZone) ? { timeZone: v.timeZone } : {}) };
  return undefined;
}

export function shapeEvent(value: unknown): Json {
  const e = obj(value);
  return {
    id: e.id,
    status: e.status,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: when(e.start),
    end: when(e.end),
    organizer: str(obj(e.organizer).email),
    attendees: arr(e.attendees).map(a => {
      const att = obj(a);
      return { email: att.email, responseStatus: att.responseStatus, ...(att.organizer === true ? { organizer: true } : {}) };
    }),
    recurringEventId: e.recurringEventId,
    htmlLink: e.htmlLink,
    updated: e.updated,
  };
}

export async function listCalendars(client: UpstreamClient, input: { pageToken?: string }): Promise<unknown> {
  const answer = obj(await client.get('calendar', '/users/me/calendarList', { maxResults: 250, pageToken: input.pageToken }));
  return {
    calendars: arr(answer.items).map(c => {
      const cal = obj(c);
      return {
        id: cal.id,
        summary: cal.summaryOverride ?? cal.summary,
        primary: cal.primary === true,
        accessRole: cal.accessRole,
        timeZone: cal.timeZone,
      };
    }),
    nextPageToken: answer.nextPageToken,
  };
}

export async function listEvents(
  client: UpstreamClient,
  input: { calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number; pageToken?: string },
): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  const answer = obj(
    await client.get('calendar', `/calendars/${calendarId}/events`, {
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      q: input.query,
      maxResults: input.maxResults ?? 50,
      pageToken: input.pageToken,
      singleEvents: true,
      orderBy: 'startTime',
    }),
  );
  return { timeZone: answer.timeZone, events: arr(answer.items).map(shapeEvent), nextPageToken: answer.nextPageToken };
}

export async function getEvent(client: UpstreamClient, input: { calendarId?: string; eventId: string }): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  return shapeEvent(await client.get('calendar', `/calendars/${calendarId}/events/${encodePathParam(input.eventId, 'eventId')}`));
}

export interface EventFields {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
}

/**
 * A start or end as the API takes it: `date` for a whole day, else `dateTime` with seconds (the API refuses
 * `10:00` without them) and the time zone when given, so `2026-11-22T10:00` with Europe/Copenhagen is 10:00 there.
 */
function eventTime(value: string, timeZone: string | undefined): Json {
  if (isDate(value)) return { date: value };
  if (!hasOffset(value) && !timeZone) throw new Error('A time without an offset needs timeZone, e.g. Europe/Copenhagen.');
  return { dateTime: withSeconds(value), ...(timeZone ? { timeZone } : {}) };
}

/** Refuses a start and end where one is a date and the other a time. */
function checkTimes(fields: EventFields): void {
  if (fields.start !== undefined && fields.end !== undefined && isDate(fields.start) !== isDate(fields.end)) {
    throw new Error('start and end must both be dates (a whole day) or both be times.');
  }
}

/** Whether start or end is a time of day without an offset, which needs a time zone. */
function needsTimeZone(fields: EventFields): boolean {
  return [fields.start, fields.end].some(value => value !== undefined && !isDate(value) && !hasOffset(value));
}

/**
 * The fields with a time zone for a time without an offset: the one given, else the calendar's own, as Google Calendar
 * itself places a time typed without a zone. The calendar's zone comes from its events list, asked for that field
 * only: the events scope covers it, also for a calendar that is not in the person's calendar list.
 */
async function withCalendarTimeZone(client: UpstreamClient, calendarId: string, fields: EventFields): Promise<EventFields> {
  checkTimes(fields);
  if (fields.timeZone || !needsTimeZone(fields)) return fields;
  const answer = obj(await client.get('calendar', `/calendars/${calendarId}/events`, { maxResults: 1, fields: 'timeZone' }));
  const timeZone = str(answer.timeZone);
  if (!timeZone) throw new Error('A time without an offset needs timeZone, e.g. Europe/Copenhagen; the calendar has none.');
  return { ...fields, timeZone };
}

export function eventBody(fields: EventFields): Json {
  const body: Json = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.location !== undefined) body.location = fields.location;
  checkTimes(fields);
  if (fields.start !== undefined) body.start = eventTime(fields.start, fields.timeZone);
  if (fields.end !== undefined) {
    // Google's end date of a whole-day event is the day after the last day. An end on the start day itself means that
    // one day, so it is moved to the day after rather than refused as an empty event.
    const end = fields.start !== undefined && isDate(fields.end) && fields.end === fields.start ? nextDay(fields.end) : fields.end;
    body.end = eventTime(end, fields.timeZone);
  }
  if (fields.attendees !== undefined) body.attendees = fields.attendees.map(email => ({ email }));
  return body;
}

export async function createEvent(client: UpstreamClient, input: EventFields & { calendarId?: string }): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  // sendUpdates=none: Google sends the attendees no invitation or update (Google notes a few mails may still go out).
  const body = eventBody(await withCalendarTimeZone(client, calendarId, input));
  const created = await client.post('calendar', `/calendars/${calendarId}/events`, body, { sendUpdates: 'none' });
  return shapeEvent(created);
}

export async function updateEvent(
  client: UpstreamClient,
  input: EventFields & { calendarId?: string; eventId: string },
): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  const path = `/calendars/${calendarId}/events/${encodePathParam(input.eventId, 'eventId')}`;
  const body = eventBody(await withCalendarTimeZone(client, calendarId, input));
  if (Object.keys(body).length === 0) throw new Error('Give at least one field to change.');
  // The fields as they were, so the change can be undone.
  const before = shapeEvent(await client.get('calendar', path));
  const after = shapeEvent(await client.patch('calendar', path, body, { sendUpdates: 'none' }));
  const changed = Object.keys(body);
  return { event: after, before: Object.fromEntries(changed.map(key => [key, before[key]])) };
}
