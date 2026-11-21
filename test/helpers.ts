import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_SCOPES, GoogleClient, SERVICES, TOKEN_URL } from '../src/google/client.js';
import { createGoogleGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';

export const CAL = SERVICES.calendar;
export const SHEETS = SERVICES.sheets;
export const DOCS = SERVICES.docs;
export const PEOPLE = SERVICES.people;
export const TASKS = SERVICES.tasks;
export const USERINFO = SERVICES.userinfo;
export { TOKEN_URL };

/** App credentials and a refresh token, all made up. */
export const APP = { clientId: '123456789012-testapp.apps.googleusercontent.com', clientSecret: 'GOCSPX-q8Zr4vLm2Wx7Kp9Nb3Jt' };
export const REFRESH = '1//0gHv7Qm2Lx9Pz4Wk8Rb5Tn3Yc6';
export const ACCESS = 'ya29.a0Hq4Zn8Vb2Mx6Lp3Kw9Rt7Ys5';

/** The path of an event in the primary calendar, and of the default task list's tasks. */
export const EVENTS = `${CAL}/calendars/primary/events`;
export const DEFAULT_TASKS = `${TASKS}/lists/%40default/tasks`;

/** An event as Google's Calendar API documents it (the events resource). */
export const EVENT = {
  kind: 'calendar#event',
  etag: '"3181161784712000"',
  id: 'abc123def456',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=YWJj',
  created: '2026-11-20T10:00:00.000Z',
  updated: '2026-11-20T10:00:00.000Z',
  summary: 'Byggemøde',
  location: 'Testvej 1, 8000 Aarhus C',
  creator: { email: 'anna@example.dk', self: true },
  organizer: { email: 'anna@example.dk', self: true },
  start: { dateTime: '2026-11-24T09:00:00+01:00', timeZone: 'Europe/Copenhagen' },
  end: { dateTime: '2026-11-24T10:00:00+01:00', timeZone: 'Europe/Copenhagen' },
  iCalUID: 'abc123def456@google.com',
  sequence: 0,
  attendees: [{ email: 'bo@example.dk', responseStatus: 'needsAction' }],
  reminders: { useDefault: true },
  eventType: 'default',
};

export type Stub = { status?: number; body?: unknown; raw?: string };

export function tokenAnswer(overrides: Record<string, unknown> = {}) {
  return { access_token: ACCESS, expires_in: 3599, scope: ALL_SCOPES.join(' '), token_type: 'Bearer', ...overrides };
}

/**
 * A fetch stub keyed by "METHOD URL" (URL without query string). Google's token endpoint answers with an access
 * token unless a test gives its own route for it. Unknown routes answer 404.
 */
export function stubFetch(routes: Record<string, Stub>) {
  const all: Record<string, Stub> = { [`POST ${TOKEN_URL}`]: { body: tokenAnswer() }, ...routes };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = all[`${init?.method ?? 'GET'} ${url}`];
    if (!stub) {
      return new Response(JSON.stringify({ error: { code: 404, message: `no stub for ${url}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
  });
}

/** The calls a stub got, without the token requests. */
export function apiCalls(fetchImpl: { mock: { calls: unknown[][] } }): Array<{ url: string; method: string; body: unknown }> {
  return fetchImpl.mock.calls
    .map(([input, init]) => ({ url: String(input), init: (init ?? {}) as RequestInit }))
    .filter(call => !call.url.startsWith(TOKEN_URL))
    .map(({ url, init }) => ({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }));
}

export function makeClient(fetchImpl: unknown, extra: Record<string, unknown> = {}) {
  return new GoogleClient({ ...APP, refreshToken: REFRESH, fetchImpl: fetchImpl as typeof fetch, credentialEnv: {}, ...extra });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

export function gateway(routes: Record<string, Stub> = {}, extra: Record<string, unknown> = {}) {
  const fetchImpl = stubFetch(routes);
  const gw = createGoogleGateway({
    ...APP,
    refreshToken: REFRESH,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...extra,
  });
  return { gw, fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** A fetch that answers Google's token endpoint with an access token and passes every other request to `f`. */
export function withToken(f: typeof fetch): typeof fetch {
  return async (input, init) =>
    String(input).startsWith(TOKEN_URL)
      ? new Response(JSON.stringify(tokenAnswer()), { status: 200, headers: { 'content-type': 'application/json' } })
      : f(input, init);
}
