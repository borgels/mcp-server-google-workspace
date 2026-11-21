import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../google/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../google/audit.js';
import { readOnlyClient, type GoogleService, type UpstreamClient } from '../google/client.js';
import { formatUnknownError, type SecretRedactor } from '../errors.js';
import { checkConnection } from '../google/account.js';
import { createEvent, getEvent, listCalendars, listEvents, updateEvent } from '../google/calendar.js';
import { createContact, listContacts, searchContacts, updateContact } from '../google/contacts.js';
import { appendText, createDocument, getDocument } from '../google/docs.js';
import { appendRows, createSpreadsheet, getSpreadsheet, readRange, updateRange } from '../google/sheets.js';
import { createTask, listTaskLists, listTasks, updateTask } from '../google/tasks.js';
import {
  calendarIdSchema,
  cellSchema,
  contactSchema,
  emailSchema,
  eventIdSchema,
  fileSchema,
  instantSchema,
  lineSchema,
  pageTokenSchema,
  rangeSchema,
  taskIdSchema,
  textSchema,
  timeZoneSchema,
  whenSchema,
} from '../google/values.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../google/policy.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the Google API,
 * the HTTP method and the path template relative to the API's root URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  /** The Google API (client.ts, SERVICES); the path is relative to its root URL. */
  service: GoogleService;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
}

/** A client that carries the redactor of its instance (GoogleClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`google_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const MAX_PAGE_SIZE_NOTE = 'Use nextPageToken from the answer for more.';

const optionalCalendar = calendarIdSchema.optional().describe('The calendar: `primary` (default) or an id from list_calendars.');
const attendeesSchema = z.array(emailSchema).max(50).describe('E-mail addresses of the attendees. No invitation is sent by mail.');
const cellRows = (what: string) => z.array(z.array(cellSchema).max(500)).min(1).max(5000).describe(what);
const dateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const eventFieldShape = {
  summary: lineSchema(500).optional().describe('Title of the event.'),
  description: textSchema(8000).optional().describe('Description.'),
  location: lineSchema(500).optional().describe('Place or address.'),
  start: whenSchema.optional().describe('Start: YYYY-MM-DD for a whole day, or YYYY-MM-DDTHH:MM with an offset or a timeZone.'),
  end: whenSchema.optional().describe('End, in the same form as start. For a whole day the day after the last day.'),
  timeZone: timeZoneSchema.optional().describe('Time zone for start and end without an offset, e.g. Europe/Copenhagen.'),
  attendees: attendeesSchema.optional(),
};

const contactFieldShape = {
  givenName: lineSchema(200).optional().describe('First name.'),
  familyName: lineSchema(200).optional().describe('Last name.'),
  emails: z.array(emailSchema).max(10).optional().describe('E-mail addresses (replace the ones there).'),
  phones: z.array(lineSchema(40)).max(10).optional().describe('Phone numbers (replace the ones there).'),
  organization: z
    .strictObject({ name: lineSchema(200).optional(), title: lineSchema(200).optional() })
    .optional()
    .describe('Company and job title.'),
};

export const GOOGLE_WORKSPACE_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'google_check_connection',
    title: 'Check connection (Google Workspace)',
    description: 'Which Google account the access is to, and which parts of Google Workspace (calendar, sheets, docs, contacts, tasks) it covers.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Checked the connection.',
    upstream: [{ access: 'read', service: 'userinfo', method: 'GET', path: '/userinfo' }],
    handler: async client => checkConnection(client),
  }),

  // Calendar
  defineTool({
    name: 'google_list_calendars',
    title: 'List calendars (Google Workspace)',
    description: `The calendars the account can see, with their ids. ${MAX_PAGE_SIZE_NOTE}`,
    inputShape: { pageToken: pageTokenSchema.optional() },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed calendars.',
    upstream: [{ access: 'read', service: 'calendar', method: 'GET', path: '/users/me/calendarList' }],
    handler: async (client, input) => listCalendars(client, input),
  }),
  defineTool({
    name: 'google_list_events',
    title: 'List events (Google Workspace)',
    description: `Events in a calendar, in order of start, recurring events as single occurrences. Narrow with timeMin, timeMax and a search text. ${MAX_PAGE_SIZE_NOTE}`,
    inputShape: {
      calendarId: optionalCalendar,
      timeMin: instantSchema.optional().describe('Only events ending after this time.'),
      timeMax: instantSchema.optional().describe('Only events starting before this time.'),
      query: lineSchema(200).optional().describe('Search text (title, description, place, attendees).'),
      maxResults: z.number().int().min(1).max(250).optional().describe('At most this many (default 50).'),
      pageToken: pageTokenSchema.optional(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed events.',
    upstream: [{ access: 'read', service: 'calendar', method: 'GET', path: '/calendars/{calendarId}/events' }],
    handler: async (client, input) => listEvents(client, input),
  }),
  defineTool({
    name: 'google_get_event',
    title: 'Get event (Google Workspace)',
    description: 'One event with its time, place, description and attendees.',
    inputShape: { calendarId: optionalCalendar, eventId: eventIdSchema.describe('The event id from list_events.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched the event.',
    upstream: [{ access: 'read', service: 'calendar', method: 'GET', path: '/calendars/{calendarId}/events/{eventId}' }],
    handler: async (client, input) => getEvent(client, input),
  }),
  defineTool({
    name: 'google_create_event',
    title: 'Create event (Google Workspace)',
    description: 'Create an event in a calendar. Attendees are added without any mail being sent.',
    inputShape: {
      ...eventFieldShape,
      calendarId: optionalCalendar,
      summary: lineSchema(500).describe('Title of the event.'),
      start: whenSchema.describe('Start: YYYY-MM-DD for a whole day, or YYYY-MM-DDTHH:MM with an offset or a timeZone.'),
      end: whenSchema.describe('End, in the same form as start. For a whole day the day after the last day.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created the event.',
    upstream: [{ access: 'write', service: 'calendar', method: 'POST', path: '/calendars/{calendarId}/events' }],
    handler: async (client, input) => createEvent(client, input),
  }),
  defineTool({
    name: 'google_update_event',
    title: 'Change event (Google Workspace)',
    description: 'Change fields of an event (title, description, place, time, attendees). The answer has the values before the change. No mail is sent.',
    inputShape: { ...eventFieldShape, calendarId: optionalCalendar, eventId: eventIdSchema.describe('The event id from list_events.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Changed the event.',
    upstream: [
      { access: 'read', service: 'calendar', method: 'GET', path: '/calendars/{calendarId}/events/{eventId}' },
      { access: 'write', service: 'calendar', method: 'PATCH', path: '/calendars/{calendarId}/events/{eventId}' },
    ],
    handler: async (client, input) => updateEvent(client, input),
  }),

  // Sheets
  defineTool({
    name: 'google_get_spreadsheet',
    title: 'Get spreadsheet (Google Workspace)',
    description: 'A spreadsheet\'s title and its sheets (names and sizes). Give its id or link.',
    inputShape: { spreadsheet: fileSchema('spreadsheets') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched the spreadsheet.',
    upstream: [{ access: 'read', service: 'sheets', method: 'GET', path: '/spreadsheets/{spreadsheetId}' }],
    handler: async (client, input) => getSpreadsheet(client, input),
  }),
  defineTool({
    name: 'google_read_range',
    title: 'Read range (Google Workspace)',
    description: 'The values in a range of a spreadsheet, row by row, as they are shown.',
    inputShape: {
      spreadsheet: fileSchema('spreadsheets'),
      range: rangeSchema,
      maxRows: z.number().int().min(1).max(5000).optional().describe('At most this many rows (default 500).'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Read the range.',
    upstream: [{ access: 'read', service: 'sheets', method: 'GET', path: '/spreadsheets/{spreadsheetId}/values/{range}' }],
    handler: async (client, input) => readRange(client, input),
  }),
  defineTool({
    name: 'google_update_range',
    title: 'Write range (Google Workspace)',
    description: 'Write values into a range, row by row. Text is stored as text, never as a formula. The answer has the values before the change.',
    inputShape: { spreadsheet: fileSchema('spreadsheets'), range: rangeSchema, values: cellRows('The rows of values.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Wrote the range.',
    upstream: [
      { access: 'read', service: 'sheets', method: 'GET', path: '/spreadsheets/{spreadsheetId}/values/{range}' },
      { access: 'write', service: 'sheets', method: 'PUT', path: '/spreadsheets/{spreadsheetId}/values/{range}' },
    ],
    handler: async (client, input) => updateRange(client, input),
  }),
  defineTool({
    name: 'google_append_rows',
    title: 'Add rows (Google Workspace)',
    description: 'Add rows after the last row of a table in a sheet. Text is stored as text, never as a formula.',
    inputShape: {
      spreadsheet: fileSchema('spreadsheets'),
      range: rangeSchema.describe('The table, e.g. Sheet1!A:D.'),
      rows: cellRows('The rows to add.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Added the rows.',
    upstream: [{ access: 'write', service: 'sheets', method: 'POST', path: '/spreadsheets/{spreadsheetId}/values/{range}:append' }],
    handler: async (client, input) => appendRows(client, input),
  }),
  defineTool({
    name: 'google_create_spreadsheet',
    title: 'Create spreadsheet (Google Workspace)',
    description: 'Create a new, empty spreadsheet in the account\'s Drive. It is shared with no one.',
    inputShape: {
      title: lineSchema(200).describe('Title.'),
      sheetTitles: z.array(lineSchema(100)).max(20).optional().describe('Names of the sheets (default one sheet).'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Created the spreadsheet.',
    upstream: [{ access: 'write', service: 'sheets', method: 'POST', path: '/spreadsheets' }],
    handler: async (client, input) => createSpreadsheet(client, input),
  }),

  // Docs
  defineTool({
    name: 'google_get_document',
    title: 'Read document (Google Workspace)',
    description: 'The text of a Google Docs document. Give its id or link.',
    inputShape: {
      document: fileSchema('document'),
      maxChars: z.number().int().min(100).max(200_000).optional().describe('At most this many characters (default 50000).'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Read the document.',
    upstream: [{ access: 'read', service: 'docs', method: 'GET', path: '/documents/{documentId}' }],
    handler: async (client, input) => getDocument(client, input),
  }),
  defineTool({
    name: 'google_append_text',
    title: 'Add text to document (Google Workspace)',
    description: 'Add text at the end of a document. Nothing in the document is removed or replaced.',
    inputShape: { document: fileSchema('document'), text: textSchema(50_000).min(1).describe('The text to add. Start with a line break for a new paragraph.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Added the text.',
    upstream: [{ access: 'write', service: 'docs', method: 'POST', path: '/documents/{documentId}:batchUpdate' }],
    handler: async (client, input) => appendText(client, input),
  }),
  defineTool({
    name: 'google_create_document',
    title: 'Create document (Google Workspace)',
    description: 'Create a new document in the account\'s Drive, optionally with text. It is shared with no one.',
    inputShape: { title: lineSchema(200).describe('Title.'), text: textSchema(50_000).optional().describe('Text of the document.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Created the document.',
    upstream: [
      { access: 'write', service: 'docs', method: 'POST', path: '/documents' },
      { access: 'write', service: 'docs', method: 'POST', path: '/documents/{documentId}:batchUpdate' },
    ],
    handler: async (client, input) => createDocument(client, input),
  }),

  // Contacts
  defineTool({
    name: 'google_list_contacts',
    title: 'List contacts (Google Workspace)',
    description: `The account's contacts with names, e-mail addresses, phone numbers and companies, latest changed first. ${MAX_PAGE_SIZE_NOTE}`,
    inputShape: {
      pageSize: z.number().int().min(1).max(200).optional().describe('At most this many (default 50).'),
      pageToken: pageTokenSchema.optional(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed contacts.',
    upstream: [{ access: 'read', service: 'people', method: 'GET', path: '/people/me/connections' }],
    handler: async (client, input) => listContacts(client, input),
  }),
  defineTool({
    name: 'google_search_contacts',
    title: 'Search contacts (Google Workspace)',
    description: 'Find contacts by name, e-mail address, phone number or company.',
    inputShape: {
      query: lineSchema(200).describe('What to search for.'),
      pageSize: z.number().int().min(1).max(30).optional().describe('At most this many (default 10).'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Searched contacts.',
    upstream: [{ access: 'read', service: 'people', method: 'GET', path: '/people:searchContacts' }],
    handler: async (client, input) => searchContacts(client, input),
  }),
  defineTool({
    name: 'google_create_contact',
    title: 'Create contact (Google Workspace)',
    description: 'Create a contact with name, e-mail addresses, phone numbers and company.',
    inputShape: contactFieldShape,
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created the contact.',
    upstream: [{ access: 'write', service: 'people', method: 'POST', path: '/people:createContact' }],
    handler: async (client, input) => {
      if (!input.givenName && !input.familyName && !input.emails?.length && !input.organization?.name) {
        throw new Error('Give a name, an e-mail address or a company.');
      }
      return createContact(client, input);
    },
  }),
  defineTool({
    name: 'google_update_contact',
    title: 'Change contact (Google Workspace)',
    description: 'Change a contact\'s name, e-mail addresses, phone numbers or company. A list given replaces the one there. The answer has the values before the change.',
    inputShape: { contact: contactSchema, ...contactFieldShape },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Changed the contact.',
    upstream: [
      { access: 'read', service: 'people', method: 'GET', path: '/people/{contactId}' },
      { access: 'write', service: 'people', method: 'PATCH', path: '/people/{contactId}:updateContact' },
    ],
    handler: async (client, input) => updateContact(client, input),
  }),

  // Tasks
  defineTool({
    name: 'google_list_task_lists',
    title: 'List task lists (Google Workspace)',
    description: 'The account\'s task lists in Google Tasks, with their ids.',
    inputShape: { pageToken: pageTokenSchema.optional() },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed task lists.',
    upstream: [{ access: 'read', service: 'tasks', method: 'GET', path: '/users/@me/lists' }],
    handler: async (client, input) => listTaskLists(client, input),
  }),
  defineTool({
    name: 'google_list_tasks',
    title: 'List tasks (Google Workspace)',
    description: `Tasks in a task list, open ones unless showCompleted. ${MAX_PAGE_SIZE_NOTE}`,
    inputShape: {
      taskList: taskIdSchema.optional().describe('The task list: `@default` (default) or an id from list_task_lists.'),
      showCompleted: z.boolean().optional().describe('Also completed tasks.'),
      dueMin: dateSchema.optional().describe('Only tasks due on or after this date.'),
      dueMax: dateSchema.optional().describe('Only tasks due before this date.'),
      maxResults: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).'),
      pageToken: pageTokenSchema.optional(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed tasks.',
    upstream: [{ access: 'read', service: 'tasks', method: 'GET', path: '/lists/{taskList}/tasks' }],
    handler: async (client, input) => listTasks(client, input),
  }),
  defineTool({
    name: 'google_create_task',
    title: 'Create task (Google Workspace)',
    description: 'Create a task in a task list.',
    inputShape: {
      taskList: taskIdSchema.optional().describe('The task list: `@default` (default) or an id from list_task_lists.'),
      title: lineSchema(1000).describe('What is to be done.'),
      notes: textSchema(8000).optional().describe('Notes.'),
      due: dateSchema.optional().describe('Due date.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created the task.',
    upstream: [{ access: 'write', service: 'tasks', method: 'POST', path: '/lists/{taskList}/tasks' }],
    handler: async (client, input) => createTask(client, input),
  }),
  defineTool({
    name: 'google_update_task',
    title: 'Change task (Google Workspace)',
    description: 'Change a task\'s title, notes or due date, or mark it done or open again. The answer has the values before the change.',
    inputShape: {
      taskList: taskIdSchema.optional().describe('The task list: `@default` (default) or an id from list_task_lists.'),
      task: taskIdSchema.describe('The task id from list_tasks.'),
      title: lineSchema(1000).optional().describe('New title.'),
      notes: textSchema(8000).optional().describe('New notes.'),
      due: dateSchema.optional().describe('New due date.'),
      completed: z.boolean().optional().describe('true: done; false: open again.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Changed the task.',
    upstream: [
      { access: 'read', service: 'tasks', method: 'GET', path: '/lists/{taskList}/tasks/{task}' },
      { access: 'write', service: 'tasks', method: 'PATCH', path: '/lists/{taskList}/tasks/{task}' },
    ],
    handler: async (client, input) => updateTask(client, input),
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return GOOGLE_WORKSPACE_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(GOOGLE_WORKSPACE_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (GOOGLE_WORKSPACE_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return GOOGLE_WORKSPACE_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          return mcpToolResult(tool, await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input)));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
        }
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
