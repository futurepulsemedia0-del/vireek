// fetch wrapper for the Supabase client: when PostgREST / Edge Functions / Storage
// reject a request with an expired JWT, wait for re-authentication and replay the
// SAME request once with the fresh token. A 401 for an invalid JWT is rejected
// before execution, so replaying is safe (no double side effects).
import { isAuthExpiredMessage } from '@/lib/session/sessionHealth';

type FetchFn = typeof fetch;

const GUARDED = ['/rest/v1/', '/functions/v1/', '/storage/v1/', '/graphql/v1'];

export interface ReauthFetchDeps {
  baseFetch: FetchFn;
  /** Returns a fresh access token after re-auth, or null if the user dismissed. */
  requestReauth: () => Promise<boolean>;
  getAccessToken: () => Promise<string | null>;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function isExpiredResponse(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body: unknown = await res.clone().json();
    if (typeof body !== 'object' || body === null) return false;
    const b = body as { message?: unknown; code?: unknown; error?: unknown };
    const msg = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : undefined;
    const code = typeof b.code === 'string' || typeof b.code === 'number' ? b.code : undefined;
    return isAuthExpiredMessage(msg, code);
  } catch {
    return false;
  }
}

export function createReauthFetch(deps: ReauthFetchDeps): FetchFn {
  return async (input, init) => {
    const retryInput = input instanceof Request ? input.clone() : input;
    const res = await deps.baseFetch(input, init);
    const url = urlOf(input);
    if (!GUARDED.some((g) => url.includes(g)) || !(await isExpiredResponse(res))) return res;

    const ok = await deps.requestReauth();
    if (!ok) return res;
    const token = await deps.getAccessToken();
    if (!token) return res;

    const headers = new Headers(init?.headers ?? (retryInput instanceof Request ? retryInput.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    return deps.baseFetch(retryInput, { ...init, headers });
  };
}
