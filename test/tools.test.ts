import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/google/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createGoogleGateway, googleGatewayTools } from '../src/gateway.js';
import { GOOGLE_WORKSPACE_TOOLS, executeTool, validateStartupConfig } from '../src/tools/google.js';
import { APP, DEFAULT_TASKS, EVENTS, REFRESH, apiCalls, auditLines, connect, gateway, makeClient, texts } from './helpers.js';

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

const item = { id: 'i1', summary: 'First item', status: 'confirmed' };
const shaped = { id: 'i1', summary: 'First item', status: 'confirmed', attendees: [] };
const task = { kind: 'tasks#task', id: 't1', title: 'First item', notes: 'text', status: 'needsAction' };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(GOOGLE_WORKSPACE_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = GOOGLE_WORKSPACE_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${EVENTS}/i1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1' } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(shaped);
    expect(note).toContain('not instructions');
    expect(apiCalls(fetchImpl)).toHaveLength(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1', other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: '..' } });
    expect(traversal.isError).toBe(true);
    expect(texts(traversal).join(' ')).toContain('event id');
    const encoded = await mcpClient.callTool({ name: 'google_get_event', arguments: { calendarId: '%2e%2e', eventId: 'x' } });
    expect(encoded.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'google_create_task', arguments: { title: 'New' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('GOOGLE_WORKSPACE_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.GOOGLE_WORKSPACE_ENABLE_WRITES = 'true';
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${DEFAULT_TASKS}`]: { body: task } });
    const result = await mcpClient.callTool({
      name: 'google_create_task',
      arguments: { title: 'First item', notes: 'text' },
    });
    expect(result.isError).toBeFalsy();
    expect(apiCalls(fetchImpl)[0]?.body).toEqual({ title: 'First item', notes: 'text' });

    const lines = auditLines(process.env.GOOGLE_WORKSPACE_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // Free text is hashed, never logged in clear text.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect((lines[0]?.target as Record<string, unknown>).titleSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('GOOGLE_WORKSPACE_AUDIT_LOG');
    expect(() => createGoogleGateway({ ...APP, refreshToken: 'tttt-gggg-wwww-vvvv-1' })).toThrow('GOOGLE_WORKSPACE_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${EVENTS}/i1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1' } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.GOOGLE_WORKSPACE_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${DEFAULT_TASKS}`]: { body: task } });
    // The log becomes unwritable after startup.
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'google_create_task', arguments: { title: 'x' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(apiCalls(fetchImpl)).toEqual([]);
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.GOOGLE_WORKSPACE_DISABLED_TOOLS = 'create_task,google_update_task';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('google_create_task');
    expect(tools.map(t => t.name)).not.toContain('google_update_task');
    expect(tools).toHaveLength(GOOGLE_WORKSPACE_TOOLS.length - 2);

    process.env.GOOGLE_WORKSPACE_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { credentialEnv: {} } })).toThrow('GOOGLE_WORKSPACE_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${EVENTS}/i1`]: { status: 400, body: { error: { code: 400, message: 'bad value: jane@vendor.test', status: 'INVALID_ARGUMENT' } } },
    });
    const result = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1' } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.GOOGLE_WORKSPACE_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...GOOGLE_WORKSPACE_TOOLS.find(t => t.name === 'google_get_event')!,
      handler: async (c: UpstreamClient) => c.post('tasks', '/lists/%40default/tasks', { title: 'x' }),
    };
    await expect(executeTool(misannotated, client, { eventId: 'i1' })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a write outside the fixed list, and any DELETE, before a token is fetched', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    await expect(client.post('calendar', '/calendars/primary/events/e1/move', {})).rejects.toThrow(/not among the writes/);
    await expect(client.post('calendar', '/calendars/primary/acl', { role: 'reader' })).rejects.toThrow(/not among the writes/);
    await expect(client.put('sheets', '/spreadsheets/1AbCdEfGhIjKlMnOp', {})).rejects.toThrow(/not among the writes/);
    await expect(client.post('people', '/people:batchDeleteContacts', {})).rejects.toThrow(/not among the writes/);
    expect('delete' in client).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = GOOGLE_WORKSPACE_TOOLS.find(t => t.name === 'google_get_event')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error(`failed: token ${REFRESH}, header Authorization: Bearer other-secret, {"client_secret":"third-secret"}`);
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'google_get_event', arguments: { eventId: 'i1' } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of [REFRESH, 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    for (const tool of googleGatewayTools) {
      expect(tool.name.startsWith('google_'), tool.name).toBe(false);
      // Nothing here deletes or cannot be undone: reads, and writes that answer with the values before.
      expect(['read', 'write'], tool.name).toContain(tool.riskLevel);
      expect(tool.enabledByDefault, tool.name).toBe(tool.riskLevel === 'read');
    }
    expect(googleGatewayTools.filter(t => t.riskLevel === 'write').map(t => t.name).sort()).toEqual([
      'append_rows',
      'append_text',
      'create_contact',
      'create_document',
      'create_event',
      'create_spreadsheet',
      'create_task',
      'update_contact',
      'update_event',
      'update_range',
      'update_task',
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of googleGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.GOOGLE_WORKSPACE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${EVENTS}/i1`]: { body: item } });

    const ok = await gw.callTool('get_event', { eventId: 'i1' }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(shaped);

    const invalid = await gw.callTool('get_event', { eventId: 'i1', extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_task', { title: 'x' });
    expect(write.isError).toBe(true);
    expect(apiCalls(fetchImpl)).toHaveLength(1);

    const lines = auditLines(process.env.GOOGLE_WORKSPACE_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: 'user@vendor.test', action: 'start' });
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
