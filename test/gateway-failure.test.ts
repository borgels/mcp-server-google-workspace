// Failure metadata on gateway error results: the upstream API's HTTP status and its request id (a UUID or hex id
// only), for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureMetadata, GoogleHttpError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { createGoogleGateway } from '../src/gateway.js';
import { APP, CAL, REFRESH, TOKEN_URL, tokenAnswer, withToken } from './helpers.js';

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const BODY = { error: { code: 404, message: 'Customer Jane Doe not found', status: 'E_NOPE' } };
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GOOGLE_WORKSPACE_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function answer(status: number, headers: Record<string, string>, body: unknown = BODY): Response {
  // A 304 has no body.
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function gatewayAnswering(status: number, headers: Record<string, string>, body?: unknown, refreshToken = REFRESH) {
  const fetchImpl = withToken((async () => answer(status, headers, body)) as typeof fetch);
  return createGoogleGateway({ ...APP, refreshToken, fetchImpl, maxAttempts: 1 });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'abc--def',
      'abcdef12-ab',
      'abcdef1',
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    expect(failureMetadata(new GoogleHttpError({ status: 404, url: `${CAL}/x`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new GoogleHttpError({ status: 500, url: `${CAL}/x`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-request-id': UUID }).callTool('get_event', { eventId: 'e1' });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(403, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool('get_event', {
      eventId: 'e1',
    });
    expect(result.failure).toEqual({ httpStatus: 403 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('carry the status and request id of a refusal from the token endpoint', async () => {
    for (const status of [400, 500]) {
      const fetchImpl = (async (input: string | URL | Request) =>
        String(input).startsWith(TOKEN_URL)
          ? answer(status, { 'x-request-id': UUID }, { error: 'invalid_grant', error_description: 'Jane Doe' })
          : answer(200, {}, {})) as typeof fetch;
      const gw = createGoogleGateway({ ...APP, refreshToken: REFRESH, fetchImpl, maxAttempts: 1 });
      const result = await gw.callTool('get_event', { eventId: 'e1' });
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status, requestId: UUID });
      expect(JSON.stringify(result)).not.toContain('Jane Doe');
      expect(JSON.stringify(result)).not.toContain('invalid_grant');
    }
  });

  it('carry the status and request id of a redirect, which is not followed, from an API or the token endpoint', async () => {
    for (const status of [301, 302, 304, 307, 308]) {
      const headers = { location: 'https://elsewhere.example/', 'x-request-id': UUID };
      const api = await gatewayAnswering(status, headers).callTool('get_event', { eventId: 'e1' });
      const fetchImpl = (async (input: string | URL | Request) =>
        String(input).startsWith(TOKEN_URL) ? answer(status, headers) : answer(200, {}, {})) as typeof fetch;
      const token = await createGoogleGateway({ ...APP, refreshToken: REFRESH, fetchImpl, maxAttempts: 1 }).callTool('get_event', {
        eventId: 'e1',
      });
      for (const result of [api, token]) {
        expect(result.isError).toBe(true);
        expect(result.failure).toEqual({ httpStatus: status, requestId: UUID });
        expect(JSON.stringify(result)).not.toContain('elsewhere');
      }
    }
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The refresh token's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-request-id': 'deadbeef00112233' }, {}, 'rt-deadbeef00112233-Hv7Qm2Lx9P').callTool(
      'get_event',
      { eventId: 'e1' },
    );
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not the upstream API', async () => {
    const gw = gatewayAnswering(200, {}, {});
    expect((await gw.callTool('get_event', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createGoogleGateway({
      ...APP,
      refreshToken: REFRESH,
      maxAttempts: 1,
      fetchImpl: withToken((async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch),
    });
    const result = await offline.callTool('get_event', { eventId: 'e1' });
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).startsWith(TOKEN_URL)
        ? answer(200, {}, tokenAnswer())
        : answer(200, { 'x-request-id': UUID }, { id: 'e1', kind: 'calendar#event' })) as typeof fetch;
    const result = await createGoogleGateway({ ...APP, refreshToken: REFRESH, fetchImpl }).callTool('get_event', { eventId: 'e1' });
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
