import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { hasOffset, isDate } from './values.js';

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

/** A start or end as the API takes it: `date` for a whole day, else `dateTime` (with the time zone when given). */
function eventTime(value: string, timeZone: string | undefined): Json {
  if (isDate(value)) return { date: value };
  if (!hasOffset(value) && !timeZone) throw new Error('A time without an offset needs timeZone, e.g. Europe/Copenhagen.');
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

export function eventBody(fields: EventFields): Json {
  const body: Json = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.start !== undefined) body.start = eventTime(fields.start, fields.timeZone);
  if (fields.end !== undefined) body.end = eventTime(fields.end, fields.timeZone);
  if (fields.start !== undefined && fields.end !== undefined && isDate(fields.start) !== isDate(fields.end)) {
    throw new Error('start and end must both be dates (a whole day) or both be times.');
  }
  if (fields.attendees !== undefined) body.attendees = fields.attendees.map(email => ({ email }));
  return body;
}

export async function createEvent(client: UpstreamClient, input: EventFields & { calendarId?: string }): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  // sendUpdates=none: Google sends the attendees no invitation or update (Google notes a few mails may still go out).
  const created = await client.post('calendar', `/calendars/${calendarId}/events`, eventBody(input), { sendUpdates: 'none' });
  return shapeEvent(created);
}

export async function updateEvent(
  client: UpstreamClient,
  input: EventFields & { calendarId?: string; eventId: string },
): Promise<unknown> {
  const calendarId = calendarPath(input.calendarId ?? 'primary');
  const path = `/calendars/${calendarId}/events/${encodePathParam(input.eventId, 'eventId')}`;
  const body = eventBody(input);
  if (Object.keys(body).length === 0) throw new Error('Give at least one field to change.');
  // The fields as they were, so the change can be undone.
  const before = shapeEvent(await client.get('calendar', path));
  const after = shapeEvent(await client.patch('calendar', path, body, { sendUpdates: 'none' }));
  const changed = Object.keys(body);
  return { event: after, before: Object.fromEntries(changed.map(key => [key, before[key]])) };
}
