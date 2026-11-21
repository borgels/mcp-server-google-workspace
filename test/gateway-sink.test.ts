// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the key.
// Every output is checked in its final form; the round-7 counterexamples and keys spliced from real outputs.
import { describe, expect, it } from 'vitest';
import { createGoogleGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { APP, DEFAULT_TASKS, EVENTS, TOKEN_URL, tokenAnswer } from './helpers.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A vendor-like value that our texts do not share. */
const PLAIN = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

/** The pieces of the key found in any text a host or a log could see. */
function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

const upstream: typeof fetch = async input => {
  const url = String(input).split('?')[0] ?? '';
  if (url === TOKEN_URL) return json(tokenAnswer());
  if (url === `${EVENTS}/i1`) return json({ id: 'i1', summary: 'Event one', status: 'confirmed' });
  if (url === DEFAULT_TASKS) return json({ id: 'i2', title: 'n' });
  return json({ error: { message: 'no stub' } }, 404);
};

/** Every output of a normal session with this key, or the refusal when the key is not admitted. */
async function outputs(apiKey: string): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  let gw: ReturnType<typeof createGoogleGateway>;
  try {
    gw = createGoogleGateway({
      ...APP,
      refreshToken: apiKey,
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('get_event', { eventId: 'i1' }, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('create_task', { title: 'n' }, { caller: 'person-1', requestId: 'r2' }),
    await gw.callTool('get_event', { eventId: 'missing' }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('get_event', { unknown: 1 }),
  ];
  return { outputs: [gw.tools, ...results, ...records] };
}

describe('the sink check', () => {
  it('holds for the round-7 counterexamples', async () => {
    for (const apiKey of [
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'qz7":"staV8k2mP9',
      'Zq7pX2-kind,p-Wb4TnR',
      'x"ok":y-0123456789',
      'URI malformedQz7pX2vK9mWb\uD800',
    ]) {
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused !== undefined) expect(refused, apiKey).toMatch(/key was refused/);
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
  });

  it('refuses a key that is not printable ASCII before anything is built from it', () => {
    for (const apiKey of ['URI malformedQz7pX2vK9mWb\uD800', 'Zq7pX2vK9mWb4TnRé', 'Zq7pX2 vK9mWb4TnR8y']) {
      expect(() => createGoogleGateway({ ...APP, refreshToken: apiKey }), apiKey).toThrow(/key was refused/);
    }
  });

  it('refuses a key that shares a piece with the tool list', () => {
    expect(() => createGoogleGateway({ ...APP, refreshToken: 'riskLevelQz7pX2vK9mWb' })).toThrow(/key was refused/);
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU');
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.flatMap(output => visibleTexts(output)).filter(text => text.length >= 6);
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 60; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiKey = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiKey);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

describe('failure texts', () => {
  it('passes on only the fields of ours, so failure lists in a successful answer never reach a host', async () => {
    const gw = createGoogleGateway({
      ...APP,
      refreshToken: PLAIN,
      maxAttempts: 1,
      policy: { enableWrites: true },
      fetchImpl: async input =>
        String(input).startsWith(TOKEN_URL)
          ? json(tokenAnswer())
          : json({ id: 'x', data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'] } }),
    });
    for (const result of [await gw.callTool('get_event', { eventId: 'x' }), await gw.callTool('create_task', { title: 'n' })]) {
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Vendor');
    }
  });
});

describe('round 8', () => {
  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiKey, clientId] of [
      ['scratchpadQz7pX2vK9mWb', ''],
      ['scratchpadQz7pX2vK9mWb', 'bad id'],
      ['Zq7pX2-node:i-Wb4TnR', 'bad id'],
      ['short', 'bad id'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createGoogleGateway({ clientId, clientSecret: APP.clientSecret, refreshToken: apiKey });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiKey).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(apiKey, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });

  it('quotes no address in network or redirect errors', async () => {
    for (const fetchImpl of [
      async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
      },
      async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere-name.invalid/' } }),
    ] as Array<typeof fetch>) {
      const gw = createGoogleGateway({ ...APP, refreshToken: PLAIN, maxAttempts: 1, fetchImpl });
      const result = await gw.callTool('get_event', { eventId: 'x' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('elsewhere-name');
      expect(JSON.stringify(result)).not.toContain('googleapis');
    }
  });
});
