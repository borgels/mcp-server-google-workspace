import { z } from 'zod/v4';

/**
 * Input values shared by the tools. Every id that goes into a path is checked
 * here against the form Google gives it, and then percent-encoded by the
 * caller (encodePathParam).
 */

/** No control characters (C0, DEL, C1) in a one-line value. */
const NO_CONTROLS = /^[^\u0000-\u001f\u007f-\u009f]*$/;

/** A calendar id: `primary`, an address such as `name@group.calendar.google.com`, or Google's own ids. */
export const calendarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .regex(/^[A-Za-z0-9_@.#+-]+$/, 'A calendar id is `primary` or an id from list_calendars.');

/** An event id: base32hex letters and digits, with `_` and a time for one instance of a recurring event. */
export const eventIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/, 'An event id is the id from list_events.');

/** A task list or task id, or `@default` for the account's default list. */
export const taskIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(@default|[A-Za-z0-9_-]+)$/, 'A task list or task id is an id from list_task_lists or list_tasks.');

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * A Google file's id, or a link to it on docs.google.com (`/spreadsheets/d/<id>/...` or `/document/d/<id>/...`).
 * Only the id is ever used; a link to any other host is refused.
 */
export function fileIdFrom(value: string, kind: 'spreadsheets' | 'document'): string | undefined {
  const text = value.trim();
  if (FILE_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return undefined;
  const match = new RegExp(`^/${kind}/(?:u/\\d+/)?d/([A-Za-z0-9_-]{10,200})(?:/|$)`).exec(url.pathname);
  return match?.[1];
}

export function fileSchema(kind: 'spreadsheets' | 'document') {
  const what = kind === 'spreadsheets' ? 'spreadsheet' : 'document';
  return z
    .string()
    .trim()
    .min(10)
    .max(2048)
    .refine(value => fileIdFrom(value, kind) !== undefined, `Give the ${what}'s id or its link on docs.google.com.`)
    .describe(`The ${what}'s id, or its link (https://docs.google.com/${kind}/d/...).`);
}

/** A range in A1 notation, e.g. `Sheet1!A1:D20` or `'Q1 sales'!A:C`. One line, no `/`, `?` or `#`. */
export const rangeSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(NO_CONTROLS)
  .regex(/^[^/\\?#]+$/, 'A range is in A1 notation, e.g. Sheet1!A1:D20. Sheet names with / ? # or \\ cannot be used.')
  .describe('A range in A1 notation, e.g. Sheet1!A1:D20.');

/** One cell value as sent with valueInputOption RAW: text is stored as text, never as a formula. */
export const cellSchema = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** A date (all day) or a date and time. */
export const whenSchema = z
  .string()
  .trim()
  .max(40)
  .refine(value => DATE.test(value) || DATE_TIME.test(value), 'Use YYYY-MM-DD for a whole day, or YYYY-MM-DDTHH:MM with an offset (+01:00) or a timeZone.');

/** A point in time with an offset, as the Calendar API requires for timeMin and timeMax. */
export const instantSchema = z
  .string()
  .trim()
  .max(40)
  .refine(value => DATE_TIME.test(value) && OFFSET.test(value), 'Use YYYY-MM-DDTHH:MM:SS with an offset, e.g. 2026-11-21T00:00:00+01:00.');

/** An IANA time zone name such as Europe/Copenhagen. */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/, 'Use an IANA time zone, e.g. Europe/Copenhagen.');

export function isDate(value: string): boolean {
  return DATE.test(value);
}

export function hasOffset(value: string): boolean {
  return OFFSET.test(value);
}

/** One line of text with no control characters. */
export function lineSchema(max: number) {
  return z.string().trim().min(1).max(max).regex(NO_CONTROLS, 'One line without control characters.');
}

/** Text that may hold line breaks and tabs, but no other control characters. */
export function textSchema(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/, 'Text without control characters.');
}

export const emailSchema = z.string().trim().max(254).email();

export const pageTokenSchema = z.string().trim().min(1).max(2048).regex(/^[\x21-\x7e]+$/).describe('The nextPageToken of an earlier answer.');

/** A contact's resource name (`people/c123...`) or just its id. */
export const contactSchema = z
  .string()
  .trim()
  .min(1)
  .max(210)
  .regex(/^(people\/)?[A-Za-z0-9_-]{1,200}$/, 'A contact is its resourceName from list_contacts or search_contacts, e.g. people/c123.')
  .describe('The contact\'s resourceName, e.g. people/c123.');

export function contactId(value: string): string {
  return value.trim().replace(/^people\//, '');
}
