# mcp-server-google-workspace

A [Model Context Protocol](https://modelcontextprotocol.io) server for Google Workspace: Google Calendar, Sheets, Docs, Contacts and Tasks for one Google account. It lets an MCP client (Claude or any other MCP-capable assistant) read and, when enabled, change events, spreadsheets, documents, contacts and tasks.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Google.

- Read-only by default; writes are opt-in per instance.
- **No restricted scopes.** No Gmail and no Drive scope, so the OAuth app needs Google's sensitive-scope verification but no CASA security assessment. Documents and spreadsheets are opened by their id or link.
- **Nothing is deleted, shared or sent by mail.** The client has a fixed list of writes and no DELETE; calendar changes are sent with `sendUpdates=none`; values are written to Sheets as `RAW`, so text is never run as a formula. Every change answers with the values before it, so it can be undone.
- One Google account per server instance (an OAuth refresh token); the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose |
|---|---|
| `google_check_connection` | Which account the access is to, and which parts of Workspace the consent covers. |
| `google_list_calendars` | The calendars the account can see. |
| `google_list_events` | Events in a calendar, by time and search text, recurring events as single occurrences. |
| `google_get_event` | One event. |
| `google_create_event` *(write)* | Create an event (no mail to attendees). |
| `google_update_event` *(write)* | Change title, description, place, time or attendees of an event (no mail). |
| `google_get_spreadsheet` | A spreadsheet's title and sheets. |
| `google_read_range` | Values in a range (A1 notation), as shown. |
| `google_update_range` *(write)* | Write values into a range (`RAW`). |
| `google_append_rows` *(write)* | Add rows after a table (`RAW`). |
| `google_create_spreadsheet` *(write)* | Create an empty spreadsheet, shared with no one. |
| `google_get_document` | The text of a document, tables included. |
| `google_append_text` *(write)* | Add text at the end of a document. |
| `google_create_document` *(write)* | Create a document, shared with no one. |
| `google_list_contacts` | The account's contacts (names, e-mail, phone, company). |
| `google_search_contacts` | Find contacts. |
| `google_create_contact` *(write)* | Create a contact. |
| `google_update_contact` *(write)* | Change a contact's name, e-mail, phone or company. |
| `google_list_task_lists` | Task lists in Google Tasks. |
| `google_list_tasks` | Tasks in a list. |
| `google_create_task` *(write)* | Create a task. |
| `google_update_task` *(write)* | Change a task, or mark it done or open. |

### Scopes

The server needs these OAuth scopes. None is restricted ([Google's list](https://support.google.com/cloud/answer/13464325)); with granular consent an account may leave some out, and `check_connection` says which parts are covered.

`openid`, `email`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/documents`, `https://www.googleapis.com/auth/contacts`, `https://www.googleapis.com/auth/tasks`.

## Quick start

Requires Node.js 22 or later, an OAuth client (web application) in a Google Cloud project with the APIs above enabled, and a refresh token for the account, from the authorization code flow with `access_type=offline` and the scopes above.

```bash
npx @borgels/mcp-server-google-workspace
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-google-workspace.git
cd mcp-server-google-workspace
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add google \
  --env GOOGLE_WORKSPACE_CLIENT_ID=<client id> --env GOOGLE_WORKSPACE_CLIENT_SECRET=<client secret> \
  --env GOOGLE_WORKSPACE_REFRESH_TOKEN=<refresh token> \
  -- npx -y @borgels/mcp-server-google-workspace
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "google": {
      "command": "npx",
      "args": ["-y", "@borgels/mcp-server-google-workspace"],
      "env": {
        "GOOGLE_WORKSPACE_CLIENT_ID": "<client id>",
        "GOOGLE_WORKSPACE_CLIENT_SECRET": "<client secret>",
        "GOOGLE_WORKSPACE_REFRESH_TOKEN": "<refresh token>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-google-workspace`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name google-mcp -p 127.0.0.1:3000:3000 \
  -e GOOGLE_WORKSPACE_CLIENT_ID=<client id> \
  -e GOOGLE_WORKSPACE_CLIENT_SECRET=<client secret> \
  -e GOOGLE_WORKSPACE_REFRESH_TOKEN=<refresh token> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-google-workspace:latest

claude mcp add --transport http google http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `GOOGLE_WORKSPACE_AUDIT_LOG` into it (e.g. `-v google-audit:/audit -e GOOGLE_WORKSPACE_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Google

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_WORKSPACE_CLIENT_ID` | – | **Required.** The OAuth client id. |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | – | **Required.** The OAuth client secret. |
| `GOOGLE_WORKSPACE_REFRESH_TOKEN` | – | **Required.** The account's refresh token. |
| `GOOGLE_WORKSPACE_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `GOOGLE_WORKSPACE_MAX_CONCURRENCY` | `4` | Maximum concurrent requests to Google. |
| `GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

Tokens are sent only to Google's own addresses (`oauth2.googleapis.com` and the API hosts in `src/google/client.ts`); there is no setting that changes them.

### Access control

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_WORKSPACE_ENABLE_WRITES` | `false` | Enable the write tools. |
| `GOOGLE_WORKSPACE_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `google_` prefix. |
| `GOOGLE_WORKSPACE_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text hashed, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createGoogleGateway, googleToolCatalog } from '@borgels/mcp-server-google-workspace/gateway';

const gateway = createGoogleGateway({
  clientId: app.clientId,
  clientSecret: app.clientSecret,
  refreshToken: connection.refreshToken,
  onRefreshToken: token => store(connection, token),
  policy: { enableWrites: true, audit: record => log(record) },
});
const result = await gateway.callTool('list_events', { timeMin: '2026-11-24T00:00:00+01:00' }, { caller: 'person-1' });
```

- **Explicit credentials.** `clientId`, `clientSecret` and `refreshToken` are required; a missing value throws when the gateway is created, and both secrets pass the key admission below. A gateway never reads them from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment. Google normally keeps a refresh token; if a token answer holds a new one, the client uses it and gives it to `onRefreshToken`.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createGoogleGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `GOOGLE_WORKSPACE_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `GOOGLE_WORKSPACE_ENABLE_WRITES`, `GOOGLE_WORKSPACE_DISABLED_TOOLS` or `GOOGLE_WORKSPACE_AUDIT_LOG`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`GOOGLE_WORKSPACE_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text.
- **Tool catalog.** `googleToolCatalog` is a frozen list of every tool: `name` (without the `google_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `service`, `method` and path template relative to the API's root). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `googleGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## Security model

- **One shared identity.** Every caller acts as the one Google account whose refresh token is configured, with everything that account can see. Connect an account with no more access than the callers should have.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the account can see. To separate data, run several instances with different accounts.
- **Writes are off by default.** No write deletes or cannot be undone, so none is annotated destructive; the client refuses any write outside its fixed list. Read-only tools get a client that refuses non-GET requests. When `GOOGLE_WORKSPACE_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **Tokens stay on Google's origins.** Redirects are never followed, tokens go only to Google's fixed `https` addresses, and error messages and audit records are redacted (by each instance, with that instance's secrets) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/google.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/google/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

Apache-2.0
