import { ConfigError, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { GoogleHttpError, describeUrl, parseRetryAfterMs, SecretRedactor } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface GoogleClientOptions {
  /** The OAuth client id of the app. When omitted, read from GOOGLE_WORKSPACE_CLIENT_ID in `credentialEnv`. */
  clientId?: string;
  /** The OAuth client secret of the app. A secret. When omitted, read from GOOGLE_WORKSPACE_CLIENT_SECRET. */
  clientSecret?: string;
  /**
   * The refresh token the account's consent gave (authorization code flow
   * with access_type=offline). A secret. When omitted, read from
   * GOOGLE_WORKSPACE_REFRESH_TOKEN.
   */
  refreshToken?: string;
  /**
   * Called when the token endpoint answers with a refresh token that differs
   * from the one in use. Google normally keeps the refresh token; a host that
   * stores tokens saves a new one here.
   */
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  /**
   * Where omitted credentials are read from. Defaults to process.env for the
   * standalone server. The gateway passes `{}`, so an embedded instance only
   * ever uses the credentials it was given.
   */
  credentialEnv?: Env;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env GOOGLE_WORKSPACE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env GOOGLE_WORKSPACE_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for idempotent GETs on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests: the clock used for the access token's lifetime. */
  now?: () => number;
}

export type QueryValue = string | number | boolean | null | undefined;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** The header that carries the access token ("Authorization: Bearer ..."); error text redaction follows it. */
export const API_KEY_HEADER = 'Authorization';

/**
 * The Google APIs this server talks to, each at the root URL of Google's
 * discovery document. Nothing else is ever sent a token: there is no option
 * that changes these addresses.
 */
export const SERVICES = {
  calendar: 'https://www.googleapis.com/calendar/v3',
  sheets: 'https://sheets.googleapis.com/v4',
  docs: 'https://docs.googleapis.com/v1',
  people: 'https://people.googleapis.com/v1',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
  userinfo: 'https://openidconnect.googleapis.com/v1',
} as const;

export type GoogleService = keyof typeof SERVICES;

/** Google's token endpoint (https://developers.google.com/identity/protocols/oauth2/web-server). */
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The scopes this server needs, none of them restricted
 * (https://support.google.com/cloud/answer/13464325): openid and email (who
 * the account is), the calendar list and events, Sheets, Docs, Contacts and
 * Tasks. No Gmail and no Drive scope.
 */
export const SCOPES = {
  openid: 'openid',
  email: 'email',
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  docs: 'https://www.googleapis.com/auth/documents',
  contacts: 'https://www.googleapis.com/auth/contacts',
  tasks: 'https://www.googleapis.com/auth/tasks',
} as const;

export const ALL_SCOPES: readonly string[] = Object.values(SCOPES);

/** The name Google gives the `email` scope in a token answer. */
const EMAIL_SCOPE_URL = 'https://www.googleapis.com/auth/userinfo.email';

const ID = '[A-Za-z0-9_@.#%+-]{1,1024}';

/**
 * The only writes the client sends: service, method and path (relative to the
 * service's root, percent-encoded as sent). Anything else is refused before a
 * token is put in a header, whatever a tool or a policy says. There is no
 * DELETE and no method for one: nothing is deleted, shared, sent by mail or
 * moved to another owner.
 */
export const ALLOWED_WRITES: ReadonlyArray<{ service: GoogleService; method: 'POST' | 'PATCH' | 'PUT'; path: RegExp }> = [
  { service: 'calendar', method: 'POST', path: new RegExp(`^/calendars/${ID}/events$`) },
  { service: 'calendar', method: 'PATCH', path: new RegExp(`^/calendars/${ID}/events/${ID}$`) },
  { service: 'sheets', method: 'POST', path: /^\/spreadsheets$/ },
  { service: 'sheets', method: 'PUT', path: /^\/spreadsheets\/[A-Za-z0-9_-]{10,200}\/values\/[^/?#]{1,900}$/ },
  { service: 'sheets', method: 'POST', path: /^\/spreadsheets\/[A-Za-z0-9_-]{10,200}\/values\/[^/?#]{1,900}:append$/ },
  { service: 'docs', method: 'POST', path: /^\/documents$/ },
  { service: 'docs', method: 'POST', path: /^\/documents\/[A-Za-z0-9_-]{10,200}:batchUpdate$/ },
  { service: 'people', method: 'POST', path: /^\/people:createContact$/ },
  { service: 'people', method: 'PATCH', path: /^\/people\/[A-Za-z0-9_-]{1,200}:updateContact$/ },
  { service: 'tasks', method: 'POST', path: new RegExp(`^/lists/${ID}/tasks$`) },
  { service: 'tasks', method: 'PATCH', path: new RegExp(`^/lists/${ID}/tasks/${ID}$`) },
];

/** An access token is renewed this long before it expires. */
const TOKEN_EARLY_RENEWAL_MS = 60_000;

const TOKEN_TEXT = /^[\x21-\x7e]{16,8192}$/;

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The client as handed to tool handlers. Read-only tools get a view whose
 * non-GET methods throw (see readOnlyClient), so the write gate does not
 * depend on tool annotations alone.
 */
export interface UpstreamClient {
  /** The scopes Google says the access covers, once a token has been fetched (undefined before). */
  readonly grantedScopes?: readonly string[];
  get<T>(service: GoogleService, path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  patch<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  put<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
}

/**
 * A view of the client that only allows GET. A read-only tool that needs a
 * POST should get an explicit, named method here rather than the full client.
 */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get grantedScopes() {
      return client.grantedScopes;
    },
    get: (service, path, query) => client.get(service, path, query),
    post: refuse('POST'),
    patch: refuse('PATCH'),
    put: refuse('PUT'),
  };
}

/** The token endpoint refused the app's access: our own text, nothing of the answer. */
export class GoogleTokenError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      `Google refused the access (HTTP ${status}). It may have been withdrawn or have expired; ` +
        'the account gives the app access again.',
    );
    this.name = 'GoogleTokenError';
    this.status = status;
  }
}

/**
 * Client for the Google APIs in SERVICES. The access token comes from the
 * refresh token and the app's client id and secret at Google's token
 * endpoint, and is sent as a Bearer token only to the hosts in SERVICES. It
 * is kept in memory, renewed a minute before it expires, and renewed once
 * when an API answers 401.
 *
 * Redirects are never followed, so no token can be forwarded to another
 * origin. Idempotent GETs are retried with backoff on throttling, gateway
 * errors and transient network failures; other methods are never retried.
 * Missing credentials only fail when a request is made, so the tool list can
 * be read without credentials.
 *
 * Each client owns a SecretRedactor holding its client secret, its refresh
 * token and the access token in use; errors raised by the client, and the
 * audit and tool results of calls made through it, are redacted with it.
 */
export class GoogleClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private refreshToken?: string;
  private readonly onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  private access?: { token: string; expiresAt: number };
  grantedScopes?: readonly string[];
  private readonly retired: string[] = [];
  private pendingToken?: Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: GoogleClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    this.clientId = options.clientId ?? readEnvString('GOOGLE_WORKSPACE_CLIENT_ID', credentialEnv);
    this.clientSecret = options.clientSecret ?? readEnvString('GOOGLE_WORKSPACE_CLIENT_SECRET', credentialEnv);
    this.refreshToken = options.refreshToken ?? readEnvString('GOOGLE_WORKSPACE_REFRESH_TOKEN', credentialEnv);
    this.onRefreshToken = options.onRefreshToken;
    this.redactor = new SecretRedactor()
      .addHeader(API_KEY_HEADER)
      .addSecret(this.clientSecret)
      .addSecret(this.refreshToken);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'GOOGLE_WORKSPACE_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(intOption('maxConcurrency', options.maxConcurrency, 'GOOGLE_WORKSPACE_MAX_CONCURRENCY', 4, 1, 64));
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async get<T>(service: GoogleService, path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', service, path, query);
  }

  async post<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('POST', service, path, query, body);
  }

  async patch<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('PATCH', service, path, query, body);
  }

  async put<T>(service: GoogleService, path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('PUT', service, path, query, body);
  }

  buildUrl(service: GoogleService, path: string, query?: Record<string, QueryValue>): string {
    if (!Object.hasOwn(SERVICES, service)) throw new Error('Unknown Google service.');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${SERVICES[service]}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** The access token in use, renewed when it is about to expire. One renewal at a time per client. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - TOKEN_EARLY_RENEWAL_MS > this.now()) return this.access.token;
    this.pendingToken ??= this.renewAccessToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private dropAccessToken(token: string): void {
    if (this.access?.token === token) this.access = undefined;
  }

  /** POST to Google's token endpoint with grant_type=refresh_token, form-encoded. */
  private async renewAccessToken(): Promise<string> {
    if (!this.clientId) throw new Error('Missing GOOGLE_WORKSPACE_CLIENT_ID. Set it in the MCP server environment.');
    if (!this.clientSecret) throw new Error('Missing GOOGLE_WORKSPACE_CLIENT_SECRET. Set it in the MCP server environment.');
    if (!this.refreshToken) throw new Error('Missing GOOGLE_WORKSPACE_REFRESH_TOKEN. Set it in the MCP server environment.');
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    };
    const answer = await this.execute('POST', TOKEN_URL, init, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new Error(redirectRefusedMessage(response, 'POST'));
      }
      if (!response.ok) {
        // The body is the token service's text: never read into an error.
        await discardBody(response);
        if (response.status === 400 || response.status === 401) throw new GoogleTokenError(response.status);
        throw new GoogleHttpError({
          status: response.status,
          url: describeUrl(TOKEN_URL),
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }
      return readResponseBody(response, this.maxResponseBytes);
    });
    const value = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
    const token = value.access_token;
    if (typeof token !== 'string' || !TOKEN_TEXT.test(token)) {
      throw new Error('Google answered the token request without an access token. Nothing in the answer was used.');
    }
    if (value.token_type !== undefined && (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer')) {
      throw new Error('Google answered the token request with another token type than Bearer. Nothing in the answer was used.');
    }
    const expiresIn =
      typeof value.expires_in === 'number' && Number.isInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 86_400
        ? value.expires_in
        : 3_600;
    if (typeof value.scope === 'string') {
      // Granular consent: the account may have left some scopes out. Only scope names of ours are kept.
      this.grantedScopes = value.scope
        .split(/\s+/)
        .map(scope => (scope === EMAIL_SCOPE_URL ? SCOPES.email : scope))
        .filter(scope => ALL_SCOPES.includes(scope));
    }
    // Earlier access tokens stay redacted for two renewals; older ones have expired and are let go.
    const previous = this.access?.token;
    this.redactor.addSecret(token);
    if (previous && previous !== token) {
      this.retired.push(previous);
      while (this.retired.length > 2) this.redactor.removeSecret(this.retired.shift() as string);
    }
    this.access = { token, expiresAt: this.now() + expiresIn * 1000 };
    const rotated = value.refresh_token;
    if (typeof rotated === 'string' && TOKEN_TEXT.test(rotated) && rotated !== this.refreshToken) {
      this.redactor.addSecret(rotated);
      this.refreshToken = rotated;
      try {
        const stored: unknown = this.onRefreshToken?.(rotated);
        // A rejected promise from the host must not become an unhandled rejection.
        if (stored && typeof (stored as Promise<void>).then === 'function') {
          (stored as Promise<void>).then(undefined, () => undefined);
        }
      } catch {
        // A host's callback failing does not fail the call; the token is in use in memory.
      }
    }
    return token;
  }

  private async request<T>(
    method: HttpMethod,
    service: GoogleService,
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(service, path, query);
    if (method !== 'GET') {
      // The fixed list of writes: anything else is refused before any token is put in a header.
      const sent = new URL(url).pathname.slice(new URL(`${SERVICES[service]}/`).pathname.length - 1);
      if (!ALLOWED_WRITES.some(entry => entry.service === service && entry.method === method && entry.path.test(sent))) {
        throw new Error(`Refused: ${method} to that Google path is not among the writes this server sends.`);
      }
    }
    // A 401 means the access token was not accepted and nothing was done: renew it once and send again.
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        [API_KEY_HEADER]: `Bearer ${token}`,
      };
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const result = await this.execute(method, url, init, async response => {
        if (isRedirect(response.status)) {
          await discardBody(response);
          throw new Error(this.redactor.redact(redirectRefusedMessage(response, method)));
        }
        if (response.status === 401 && attempt === 1) {
          await discardBody(response);
          return { unauthorised: true as const };
        }
        if (!response.ok) {
          // The body is Google's text: it is never read into an error, a result or an audit record.
          await discardBody(response);
          throw new GoogleHttpError({
            status: response.status,
            url: describeUrl(url),
            retryAfter: response.headers.get('retry-after') ?? undefined,
          });
        }
        return { body: (await readResponseBody(response, this.maxResponseBytes)) as T };
      });
      if ('unauthorised' in result) {
        this.dropAccessToken(token);
        continue;
      }
      return result.body;
    }
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * idempotent GETs on retryable statuses and transient network errors
   * within the retry budget. `handle` runs while the concurrency slot is
   * held, so body reads count against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = method === 'GET' ? this.maxAttempts : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is not quoted.
  private transportError(method: HttpMethod, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`Google API request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling the Google API (${method})${shown}.`), { cause: error });
  }
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      // The value is not quoted: an option may hold a secret put there by mistake.
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The redirect's Location is Google's text and is never quoted; only the status and our own request. */
function redirectRefusedMessage(response: Response, method: HttpMethod): string {
  return `Google API responded with a redirect (HTTP ${response.status}) for ${method}; redirects are not followed.`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`Google API response of ${declared} bytes exceeds the ${maxBytes} byte limit (GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES).`);
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    // A timeout or a dropped connection goes on to execute(), which reports it as a transport error. Anything else
    // thrown while reading the body is replaced by a fixed text: its message is not ours.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error('The Google API response could not be read.');
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    throw new Error(`Google API response exceeds the ${maxBytes} byte limit (GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES).`);
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
