import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GoogleClient, type GoogleClientOptions } from './google/client.js';
import { registerTools } from './tools/google.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: GoogleClient;
  clientOptions?: GoogleClientOptions;
}

let defaultClient: GoogleClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): GoogleClient {
  defaultClient ??= new GoogleClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'google-workspace',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new GoogleClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
