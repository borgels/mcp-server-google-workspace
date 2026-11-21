import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, GoogleClient, SERVICES } from '../src/google/client.js';
import { createGoogleGateway, googleGatewayTools, googleToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { GOOGLE_WORKSPACE_TOOLS } from '../src/tools/google.js';
import { ACCESS, APP, EVENTS, REFRESH, TOKEN_URL, auditLines, connect, stubFetch, texts, tokenAnswer } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'google-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GOOGLE_WORKSPACE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'alpha-0123456789-kq';
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

/** The form a token request sent. */
function tokenForm(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

describe('explicit gateway credentials', () => {
  it('requires clientId, clientSecret and refreshToken and ignores the environment', () => {
    process.env.GOOGLE_WORKSPACE_CLIENT_ID = APP.clientId;
    process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = APP.clientSecret;
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN = ENV_KEY;

    expect(() => createGoogleGateway({ ...APP } as never)).toThrow(/requires options\.refreshToken/);
    expect(() => createGoogleGateway({ clientId: APP.clientId, refreshToken: KEY_A } as never)).toThrow(/requires options\.clientSecret/);
    expect(() => createGoogleGateway({ clientSecret: APP.clientSecret, refreshToken: KEY_A } as never)).toThrow(/requires options\.clientId/);
    expect(() => createGoogleGateway({ ...APP, refreshToken: '  ' })).toThrow(/requires options\.refreshToken/);
    expect(() => createGoogleGateway(undefined as never)).toThrow(/requires options\.clientSecret/);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, GOOGLE_WORKSPACE_REFRESH_TOKEN: ENV_KEY, GOOGLE_WORKSPACE_CLIENT_SECRET: APP.clientSecret };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createGoogleGateway({ ...APP } as never)).toThrow(/requires options\.refreshToken/);

    const fetchImpl = stubFetch({ [`GET ${EVENTS}/i1`]: { body: { id: 'i1' } } });
    const gw = createGoogleGateway({ ...APP, refreshToken: KEY_A, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_event', { eventId: 'i1' });
    expect(result.isError).toBeUndefined();
    expect(tokenForm(fetchImpl.mock.calls[0]?.[1]).get('refresh_token')).toBe(KEY_A);
    expect(headersOf(fetchImpl.mock.calls[1]?.[1])[API_KEY_HEADER]).toBe(`Bearer ${ACCESS}`);

    for (const name of ['GOOGLE_WORKSPACE_REFRESH_TOKEN', 'GOOGLE_WORKSPACE_CLIENT_ID', 'GOOGLE_WORKSPACE_CLIENT_SECRET']) {
      expect(reads.has(name), name).toBe(false);
    }
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.GOOGLE_WORKSPACE_CLIENT_ID = APP.clientId;
    process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = APP.clientSecret;
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN = ENV_KEY;
    const fetchImpl = stubFetch({ [`GET ${EVENTS}/1`]: { body: {} } });
    await new GoogleClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).get('calendar', '/calendars/primary/events/1');
    expect(tokenForm(fetchImpl.mock.calls[0]?.[1] as RequestInit).get('refresh_token')).toBe(ENV_KEY);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createGoogleGateway({ ...APP, refreshToken: KEY_A, fetchImpl: echoingFetch(KEY_A) });
    const b = createGoogleGateway({ ...APP, refreshToken: KEY_B, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_event', { eventId: 'i1' })).join(' ');
    const resultB = texts(await b.callTool('get_event', { eventId: 'i1' })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new GoogleClient({ ...APP, refreshToken: KEY_A, credentialEnv: {} });
    const b = new GoogleClient({ ...APP, refreshToken: KEY_B, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createGoogleGateway({ ...APP, refreshToken: `short-lived-key-${index}` });
    }
    const fresh = new GoogleClient({ ...APP, refreshToken: KEY_A, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createGoogleGateway({ ...APP, refreshToken: KEY_A, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = createGoogleGateway({ ...APP, refreshToken: KEY_B, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_event', { eventId: 'i1' }, { requestId: 'a' });
    await b.callTool('get_event', { eventId: 'i1' }, { requestId: 'b' });

    const errors = auditLines(process.env.GOOGLE_WORKSPACE_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual(['a', 'b']);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = GOOGLE_WORKSPACE_TOOLS.find(t => t.name === 'google_get_event')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error(`failed with ${REFRESH}`);
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1' } });
      expect(texts(result).join(' ')).not.toContain(REFRESH);
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createGoogleGateway> | undefined = createGoogleGateway({
      ...APP,
      refreshToken: fakeKey('collectable'),
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
const DOC_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxw';

/** The value of each path placeholder in the sample inputs (and the defaults the tools use). */
const PLACEHOLDERS: Record<string, string> = {
  calendarId: 'primary',
  eventId: 'ev1',
  spreadsheetId: SHEET_ID,
  range: 'Ark1!A1:B2',
  documentId: DOC_ID,
  contactId: 'c42',
  taskList: '@default',
  task: 't1',
};

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  check_connection: {},
  list_calendars: {},
  list_events: { timeMin: '2026-11-01T00:00:00+01:00' },
  get_event: { eventId: 'ev1' },
  create_event: { summary: 'Møde', start: '2026-11-24T09:00:00+01:00', end: '2026-11-24T10:00:00+01:00' },
  update_event: { eventId: 'ev1', summary: 'Nyt navn' },
  get_spreadsheet: { spreadsheet: SHEET_ID },
  read_range: { spreadsheet: SHEET_ID, range: 'Ark1!A1:B2' },
  update_range: { spreadsheet: SHEET_ID, range: 'Ark1!A1:B2', values: [['a', 1]] },
  append_rows: { spreadsheet: SHEET_ID, range: 'Ark1!A1:B2', rows: [['a', 1]] },
  create_spreadsheet: { title: 'Budget' },
  get_document: { document: DOC_ID },
  append_text: { document: DOC_ID, text: 'Hej' },
  create_document: { title: 'Notat', text: 'Hej' },
  list_contacts: {},
  search_contacts: { query: 'Anna' },
  create_contact: { givenName: 'Anna' },
  update_contact: { contact: 'people/c42', givenName: 'Anna' },
  list_task_lists: {},
  list_tasks: {},
  create_task: { title: 'Ring til kunden' },
  update_task: { task: 't1', completed: true },
};

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(googleToolCatalog.map(entry => entry.name)).toEqual(googleGatewayTools.map(tool => tool.name));
    for (const entry of googleToolCatalog) {
      const { upstream, broad, ...definition } = entry;
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(googleGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      googleToolCatalog.map(entry => `google_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = googleToolCatalog.find(e => `google_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(googleToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(googleToolCatalog);
    expect(() => {
      (googleToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.GOOGLE_WORKSPACE_ENABLE_WRITES = 'true';
    for (const entry of googleToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).startsWith(TOKEN_URL) ? Response.json(tokenAnswer()) : Response.json({ etag: '"e1"', documentId: DOC_ID }),
      );
      const gw = createGoogleGateway({ ...APP, refreshToken: KEY_A, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await gw.callTool(entry.name, input as GatewayJsonObject);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        service: op.service,
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(PLACEHOLDERS[name] ?? '')),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
        .filter(([url]) => !String(url).startsWith(TOKEN_URL))
        .map(([url, init]) => {
          const [service, root] = Object.entries(SERVICES).find(([, base]) => String(url).startsWith(`${base}/`))!;
          return { service, method: init.method ?? 'GET', path: new URL(url).pathname.slice(new URL(root).pathname.length) };
        });
      expect(made.length, entry.name).toBeGreaterThan(0);
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
