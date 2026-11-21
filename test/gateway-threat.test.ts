// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body, failures reported inside a successful body, and a result too
// deep to serialise naively. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createGoogleGateway } from '../src/gateway.js';
import { APP, REFRESH, withToken } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';

function stub(key: string): typeof fetch {
  return withToken(async input => {
    const url = String(input).split('?')[0] ?? '';
    if (url.endsWith('/values/numbers')) {
      return json({ range: 'A1:C2', majorDimension: 'ROWS', values: [[Number(key), Number(key.slice(1, 7)), Number(`${key}9`)], [true, 3]] });
    }
    if (url.endsWith('/events/body-fails')) {
      // The vendor's text and a piece of the key shorter than six characters.
      return failingBody(`Vendor diagnostic ${key.slice(0, 5)}`);
    }
    if (url.endsWith('/values/deep')) {
      return new Response(`{"values":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}`, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return json({ error: { message: 'no stub' } }, 404);
  });
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const gw = createGoogleGateway({ ...APP, refreshToken: key, fetchImpl: stub(key), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('read_range', { spreadsheet: SHEET, range: 'numbers' });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(result.structuredContent).toEqual({
      range: 'A1:C2',
      values: [['‹redacted›', '‹redacted›', '‹redacted›'], [true, 3]],
      rowCount: 2,
    });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toMatch(/234567|12345678/);
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    const gw = createGoogleGateway({ ...APP, refreshToken: KEY, fetchImpl: stub(KEY), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_event', { eventId: 'body-fails' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The Google API response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const gw = createGoogleGateway({ ...APP, refreshToken: KEY, fetchImpl: stub(KEY), maxAttempts: 1, maxResponseBytes: 1_000_000 });
    const result = await gw.callTool('read_range', { spreadsheet: SHEET, range: 'deep' });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    // Only cells are passed on; a value nested in a cell is not a cell.
    expect(result.structuredContent).toEqual({ values: [[null]], rowCount: 1 });
  });
});

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const apiKey of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createGoogleGateway({ ...APP, refreshToken: apiKey }), apiKey).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = createGoogleGateway({
      ...APP,
      refreshToken: LOOKALIKE,
      maxAttempts: 1,
      fetchImpl: withToken(async () => json({ summary: LOOKALIKE, [LOOKALIKE]: 1 })),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_event', { eventId: LOOKALIKE }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = createGoogleGateway({
      ...APP,
      refreshToken: KEY,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_event', { eventId: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Google API request failed with HTTP 500/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = createGoogleGateway({
        ...APP,
        refreshToken: KEY,
        maxAttempts: 1,
        fetchImpl: withToken(async () => json({ summary: 'ok' })),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('get_event', { eventId: 'x' });
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const apiKey of ['[nested too deep]-0123456789', 'google-mcp-0123456789', 'GOOGLE_WORKSPACE_REFRESH_TOKEN-0123456789']) {
      let message = '';
      try {
        createGoogleGateway({ ...APP, refreshToken: apiKey });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, apiKey).toMatch(/key was refused/);
      for (const piece of pieces(apiKey)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createGoogleGateway({ clientId: `https://${HOSTLIKE}.vendor.invalid/x y=${HOSTLIKE}`, clientSecret: APP.clientSecret, refreshToken: REFRESH, policy: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = createGoogleGateway({
      ...APP,
      refreshToken: KEY,
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
      },
    });
    const result = await gw.callTool('get_event', { eventId: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('VENDOR_DIAGNOSTIC');
  });
});
