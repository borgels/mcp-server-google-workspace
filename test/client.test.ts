import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_SCOPES, API_KEY_HEADER, GoogleClient, GoogleTokenError, SERVICES, TOKEN_URL } from '../src/google/client.js';
import { GoogleHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';
import { ACCESS, APP, REFRESH, tokenAnswer } from './helpers.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const CAL = SERVICES.calendar;

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;
type SpyFetch = typeof fetch & ReturnType<typeof vi.fn> & { wrapped: typeof fetch; tokenCalls: RequestInit[] };

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A spy for the API requests only. The client is given `wrapped`, which answers Google's token endpoint with an
 * access token (recording the request in `tokenCalls`) and passes every other request to the spy.
 */
function makeFetch(handler: Handler, token: () => Response = () => jsonResponse(tokenAnswer(), 200)): SpyFetch {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as SpyFetch;
  spy.tokenCalls = [];
  spy.wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TOKEN_URL) {
      spy.tokenCalls.push(init ?? {});
      return token();
    }
    return spy(input, init);
  }) as typeof fetch;
  return spy;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: SpyFetch, extra: Partial<ConstructorParameters<typeof GoogleClient>[0]> = {}) {
  return new GoogleClient({ ...APP, refreshToken: REFRESH, credentialEnv: {}, fetchImpl: fetchImpl.wrapped, sleep: noSleep, ...extra });
}

describe('GoogleClient and the access token', () => {
  it('gets an access token with the refresh token, sends it as Bearer with the User-Agent, and never follows redirects', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true }));
    await makeClient(fetchImpl).get('calendar', '/users/me/calendarList', { maxResults: 5 });

    const form = new URLSearchParams(String(fetchImpl.tokenCalls[0]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
    });
    expect(headersOf(fetchImpl.tokenCalls[0])['Content-Type']).toBe('application/x-www-form-urlencoded');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CAL}/users/me/calendarList?maxResults=5`);
    expect(headersOf(init)[API_KEY_HEADER]).toBe(`Bearer ${ACCESS}`);
    expect(headersOf(init)['User-Agent']).toBe(USER_AGENT);
    expect(init.redirect).toBe('manual');
  });

  it('keeps the access token until shortly before it expires, and fetches one at a time', async () => {
    let now = 1_000_000;
    const fetchImpl = makeFetch(() => ({ ok: true }));
    const client = makeClient(fetchImpl, { now: () => now });
    await Promise.all([client.get('calendar', '/a'), client.get('calendar', '/b'), client.get('calendar', '/c')]);
    expect(fetchImpl.tokenCalls).toHaveLength(1);
    now += 3_000_000; // 50 minutes: still more than a minute left of 3599 seconds
    await client.get('calendar', '/d');
    expect(fetchImpl.tokenCalls).toHaveLength(1);
    now += 560_000; // less than a minute left
    await client.get('calendar', '/e');
    expect(fetchImpl.tokenCalls).toHaveLength(2);
  });

  it('renews the access token once after a 401 and sends again', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => (++calls === 1 ? jsonResponse({ error: { code: 401 } }, 401) : { ok: true }));
    await expect(makeClient(fetchImpl).get('calendar', '/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl.tokenCalls).toHaveLength(2);

    const always = makeFetch(() => jsonResponse({ error: { code: 401 } }, 401));
    const error = await makeClient(always).get('calendar', '/x').catch((e: unknown) => e);
    expect((error as GoogleHttpError).status).toBe(401);
    expect(always).toHaveBeenCalledTimes(2);
  });

  it('says the access was refused when the token endpoint answers 400 or 401, without its text', async () => {
    const fetchImpl = makeFetch(
      () => ({ ok: true }),
      () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    );
    const error = await makeClient(fetchImpl).get('calendar', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect((error as Error).message).not.toMatch(/invalid_grant|revoked/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a token answer without an access token or of another type', async () => {
    for (const answer of [{ expires_in: 3599 }, { access_token: 'short' }, tokenAnswer({ token_type: 'MAC' })]) {
      const fetchImpl = makeFetch(() => ({ ok: true }), () => jsonResponse(answer, 200));
      await expect(makeClient(fetchImpl).get('calendar', '/x')).rejects.toThrow(/Nothing in the answer was used/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('keeps the scopes the account granted, by our names only', async () => {
    const granted = `openid https://www.googleapis.com/auth/userinfo.email ${ALL_SCOPES[3]} https://www.googleapis.com/auth/other`;
    const fetchImpl = makeFetch(() => ({ ok: true }), () => jsonResponse(tokenAnswer({ scope: granted }), 200));
    const client = makeClient(fetchImpl);
    expect(client.grantedScopes).toBeUndefined();
    await client.get('calendar', '/x');
    expect(client.grantedScopes).toEqual(['openid', 'email', ALL_SCOPES[3]]);
  });

  it('uses a new refresh token from the answer, gives it to the host and redacts both', async () => {
    const NEW = 'rt-test-NewRotated-Kq8Zm3Wv7';
    const saved: string[] = [];
    const fetchImpl = makeFetch(() => ({ ok: true }), () => jsonResponse(tokenAnswer({ refresh_token: NEW }), 200));
    const client = makeClient(fetchImpl, { onRefreshToken: token => void saved.push(token) });
    await client.get('calendar', '/x');
    expect(saved).toEqual([NEW]);
    expect(client.redactor.redact(`${REFRESH} ${NEW} ${ACCESS}`)).not.toMatch(/Rotated|Hv7Qm2|Hq4Zn8/);

    // A host's failing callback does not fail the call.
    const failing = makeClient(fetchImpl, { onRefreshToken: () => Promise.reject(new Error('store down')) });
    await expect(failing.get('calendar', '/x')).resolves.toEqual({ ok: true });
  });

  it('throws before sending anything when a credential is missing', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true }));
    for (const missing of ['clientId', 'clientSecret', 'refreshToken'] as const) {
      const client = makeClient(fetchImpl, { [missing]: undefined });
      await expect(client.get('calendar', '/x')).rejects.toThrow(/Missing GOOGLE_WORKSPACE_/);
    }
    expect(fetchImpl.tokenCalls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a token only to the Google APIs in SERVICES', () => {
    const client = makeClient(makeFetch(() => ({})));
    for (const base of Object.values(SERVICES)) {
      expect(new URL(base).protocol).toBe('https:');
      expect(new URL(base).hostname.endsWith('.googleapis.com')).toBe(true);
    }
    expect(() => client.buildUrl('elsewhere' as never, '/x')).toThrow(/Unknown Google service/);
    expect(new URL(client.buildUrl('calendar', '//evil.test/x')).hostname).toBe('www.googleapis.com');
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    process.env.GOOGLE_WORKSPACE_TIMEOUT_MS = '30s';
    expect(() => new GoogleClient({ credentialEnv: {} })).toThrow('GOOGLE_WORKSPACE_TIMEOUT_MS');
    process.env.GOOGLE_WORKSPACE_TIMEOUT_MS = '3000000000';
    expect(() => new GoogleClient({ credentialEnv: {} })).toThrow('GOOGLE_WORKSPACE_TIMEOUT_MS');
    delete process.env.GOOGLE_WORKSPACE_TIMEOUT_MS;
    process.env.GOOGLE_WORKSPACE_MAX_CONCURRENCY = 'many';
    expect(() => new GoogleClient({ credentialEnv: {} })).toThrow('GOOGLE_WORKSPACE_MAX_CONCURRENCY');
    delete process.env.GOOGLE_WORKSPACE_MAX_CONCURRENCY;
    process.env.GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES = '10MB';
    expect(() => new GoogleClient({ credentialEnv: {} })).toThrow('GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES');
    delete process.env.GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES;

    expect(() => new GoogleClient({ maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => new GoogleClient({ maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => new GoogleClient({ timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => new GoogleClient({ maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('the fixed list of writes', () => {
  it('sends the writes on the list and refuses every other, before a token is fetched', async () => {
    const fetchImpl = makeFetch(() => ({ ok: true }));
    const client = makeClient(fetchImpl);
    await client.post('calendar', '/calendars/primary/events', {});
    await client.patch('calendar', '/calendars/team%40group.calendar.google.com/events/abc_20261124T080000Z', {});
    await client.put('sheets', '/spreadsheets/1AbCdEfGhIjKlMnOp/values/Ark1!A1%3AB2', {});
    await client.post('sheets', '/spreadsheets/1AbCdEfGhIjKlMnOp/values/Ark1!A%3AB:append', {});
    await client.post('docs', '/documents/1AbCdEfGhIjKlMnOp:batchUpdate', {});
    await client.post('people', '/people:createContact', {});
    await client.patch('people', '/people/c123:updateContact', {});
    await client.post('tasks', '/lists/%40default/tasks', {});
    await client.patch('tasks', '/lists/%40default/tasks/t1', {});
    expect(fetchImpl).toHaveBeenCalledTimes(9);

    const refused: Array<[keyof typeof SERVICES, 'post' | 'patch' | 'put', string]> = [
      ['calendar', 'post', '/calendars/primary/events/e1/move'],
      ['calendar', 'post', '/calendars/primary/acl'],
      ['calendar', 'post', '/calendars/primary/events/quickAdd'],
      ['calendar', 'post', '/calendars/primary/clear'],
      ['calendar', 'patch', '/calendars/primary'],
      ['sheets', 'post', '/spreadsheets/1AbCdEfGhIjKlMnOp:batchUpdate'],
      ['sheets', 'post', '/spreadsheets/1AbCdEfGhIjKlMnOp/values/A1:clear'],
      ['sheets', 'post', '/spreadsheets/1AbCdEfGhIjKlMnOp/values:batchClear'],
      ['people', 'post', '/people:batchDeleteContacts'],
      ['people', 'patch', '/people/c1:updateContactPhoto'],
      ['tasks', 'post', '/lists/%40default/clear'],
      ['tasks', 'post', '/lists/l1/tasks/t1/move'],
      ['tasks', 'post', '/users/@me/lists'],
      ['userinfo', 'post', '/userinfo'],
    ];
    for (const [service, method, path] of refused) {
      await expect(client[method](service, path, {}), `${method} ${service} ${path}`).rejects.toThrow(/not among the writes/);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect('delete' in client).toBe(false);
  });
});

describe('error handling', () => {
  it("gives the status and our own hint, never Google's body, reason or status text", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }, 403),
    );
    const error = await makeClient(fetchImpl).get('calendar', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect((error as GoogleHttpError).status).toBe(403);
    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).toContain('access given does not cover it');
    expect((error as Error).message).not.toMatch(/insufficient|PERMISSION_DENIED/);
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('calendar', '/x')
      .catch((e: unknown) => e)) as GoogleHttpError;
    expect(error.message).toBe('Google API request failed with HTTP 502');
  });

  it('redacts the secrets of the client wherever they appear', async () => {
    const redactor = makeClient(makeFetch(() => ({}))).redactor;
    for (const secret of [REFRESH, APP.clientSecret, encodeURIComponent(REFRESH)]) {
      expect(redactor.redact(`proxy said ${secret}`)).not.toContain(secret.slice(2, 10));
    }
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('refresh_token=abc123&x=1')).not.toContain('abc123');
    expect(redactSecrets('"client_secret": "abc123"')).not.toContain('abc123');
    expect(redactSecrets('GOOGLE_WORKSPACE_REFRESH_TOKEN=abc123')).not.toContain('abc123');
  });

  it('redacts the access token in use, and lets go of old ones after two renewals', async () => {
    let n = 0;
    const tokens = ['at-first-Zq7pX2vK9mWb', 'at-second-Hk4Lm8Np2Qr', 'at-third-Tv6Wx1Yz3Ab', 'at-fourth-Cd5Ef7Gh9Ij'];
    let now = 0;
    const fetchImpl = makeFetch(() => ({}), () => jsonResponse(tokenAnswer({ access_token: tokens[n++], expires_in: 120 }), 200));
    const client = makeClient(fetchImpl, { now: () => now });
    for (let i = 0; i < 4; i += 1) {
      await client.get('calendar', '/x');
      now += 120_000;
    }
    expect(client.redactor.hasSecret(tokens[3]!)).toBe(true);
    expect(client.redactor.hasSecret(tokens[2]!)).toBe(true);
    expect(client.redactor.hasSecret(tokens[1]!)).toBe(true);
    expect(client.redactor.hasSecret(tokens[0]!)).toBe(false);
    expect(client.redactor.hasSecret(REFRESH)).toBe(true);
  });

  it('redacts a credential header by name', () => {
    const redactor = new SecretRedactor().addHeader(API_KEY_HEADER);
    for (const text of ['{"authorization":"Bearer abc123"}', 'Authorization: Bearer abc123', 'authorization=abc123']) {
      expect(redactor.redact(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get('calendar', '/calendars/primary/events', { q: 'secret-search' })
      .catch((e: unknown) => e)) as GoogleHttpError;
    expect(error.url).toBe(`${CAL}/calendars/primary/events`);
    expect(error.message).not.toContain('secret-search');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('calendar', '/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling the Google API \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(() => new Response('x'.repeat(2000), { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('calendar', '/x')).rejects.toThrow('exceeds the 1000 byte limit');
    await expect(makeClient(big, { maxResponseBytes: 5000 }).get('calendar', '/x')).resolves.toBe('x'.repeat(2000));
  });

  it('never follows a redirect and never quotes its target', async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/v1?t=1' } }));
    const message = await makeClient(fetchImpl)
      .get('calendar', '/x')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).not.toContain('other.vendor.test');
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) return jsonResponse({}, 429, { 'retry-after': '2' });
      if (status) return jsonResponse({}, status);
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });
    await expect(client.get('calendar', '/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('calendar', '/x')
      .catch((e: unknown) => e)) as GoogleHttpError;
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries a write', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('tasks', '/lists/l1/tasks', {})).rejects.toBeInstanceOf(GoogleHttpError);
    await expect(client.patch('tasks', '/lists/l1/tasks/t1', {})).rejects.toBeInstanceOf(GoogleHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, () => client.get('calendar', '/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});
