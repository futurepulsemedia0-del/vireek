import { ApiError, CliError, EXIT } from './errors.js';

export type QueryValue = string | number | undefined;

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 120_000;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(interrupted());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(interrupted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function interrupted(): CliError {
  return new CliError('Interrupted.', { exitCode: EXIT.INTERRUPTED });
}

/** Retry-After in seconds (the only form api-v1 emits) or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly sleep: NonNullable<ApiClientOptions['sleep']>;
  private readonly random: () => number;
  private readonly onRetry?: (info: RetryInfo) => void;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent ?? 'vireek-cli';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.signal = options.signal;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
  }

  buildUrl(pathname: string, query: Record<string, QueryValue> = {}): URL {
    const url = new URL(`${this.baseUrl}/${pathname.replace(/^\/+/, '')}`);
    // Block "../" tricks from escaping the API prefix.
    if (url.pathname !== this.basePath && !url.pathname.startsWith(`${this.basePath}/`)) {
      throw new CliError(`Refusing to request a path outside the API: ${pathname}`, { exitCode: EXIT.USAGE });
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
  }

  async get<T = unknown>(pathname: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = this.buildUrl(pathname, query);
    for (let attempt = 0; ; attempt += 1) {
      if (this.signal?.aborted) throw interrupted();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'User-Agent': this.userAgent },
          signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (this.signal?.aborted) throw interrupted();
        if (attempt >= this.maxRetries) {
          throw new CliError(`Cannot reach the Vireek API (${describeNetworkError(error)}).`, {
            hint: `Check your connection and the base URL (${this.baseUrl}).`,
            cause: error,
          });
        }
        await this.wait(attempt, undefined, describeNetworkError(error));
        continue;
      }

      if (response.ok) return parseJson<T>(response);

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await response.body?.cancel().catch(() => undefined);
        await this.wait(attempt, retryAfter, `HTTP ${response.status}`);
        continue;
      }
      throw await toApiError(response);
    }
  }

  private async wait(attempt: number, retryAfterMs: number | undefined, reason: string): Promise<void> {
    const backoff = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.random() / 2);
    const delayMs = Math.round(retryAfterMs ?? backoff);
    this.onRetry?.({ attempt: attempt + 1, delayMs, reason });
    await this.sleep(delayMs, this.signal);
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'request timed out';
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? error.message;
  }
  return String(error);
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new CliError('The API returned a non-JSON response.', {
      hint: 'The base URL probably does not point at the Vireek api-v1 function.',
      cause: error,
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
  } catch {
    /* non-JSON error body: keep the status line */
  }
  switch (response.status) {
    case 401:
      return new ApiError(401, message, { exitCode: EXIT.AUTH, hint: 'Check the key, or create a new one under Dashboard → API Keys.' });
    case 403:
      return new ApiError(403, message, { exitCode: EXIT.AUTH, hint: 'Create a key that includes the missing scope under Dashboard → API Keys.' });
    default:
      return new ApiError(response.status, `API error: ${message}`);
  }
}

export interface Page {
  data: Record<string, unknown>[];
  has_more?: boolean;
  next_before?: string | null;
}

export interface PaginateOptions {
  pageSize?: number;
  /** Only rows created strictly before this ISO timestamp. */
  before?: string;
  /** Stop once rows are older than this ISO timestamp (results are newest-first). */
  since?: string;
  /** Maximum number of rows to yield. */
  max?: number;
}

/**
 * Walks a list endpoint newest → oldest using the `before` cursor and yields
 * one array per page. De-duplicates by id and refuses to loop if the cursor
 * stops advancing.
 */
export async function* paginate(
  client: ApiClient,
  resource: string,
  options: PaginateOptions = {},
): AsyncGenerator<Record<string, unknown>[]> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
  const sinceMs = options.since === undefined ? undefined : Date.parse(options.since);
  const seen = new Set<string>();
  let remaining = options.max ?? Number.POSITIVE_INFINITY;
  let before = options.before;

  while (remaining > 0) {
    const page = await client.get<Page>(`/${resource}`, { limit: pageSize, before });
    if (!page || !Array.isArray(page.data)) {
      throw new CliError('The API returned an unexpected list shape (missing "data" array).');
    }
    let rows = page.data;
    let reachedSince = false;
    if (sinceMs !== undefined) {
      const cut = rows.findIndex((row) => Date.parse(String(row.created_at)) < sinceMs);
      if (cut !== -1) {
        rows = rows.slice(0, cut);
        reachedSince = true;
      }
    }
    rows = rows.filter((row) => {
      const id = String(row.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (rows.length > remaining) rows = rows.slice(0, remaining);
    remaining -= rows.length;
    if (rows.length > 0) yield rows;

    const next = page.next_before ?? null;
    if (reachedSince || !page.has_more || !next || next === before || page.data.length === 0) return;
    before = next;
  }
}
