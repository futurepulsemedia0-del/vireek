// supabase/functions/_shared/price-book/jobberGraphql.ts
//
// The ONE way Vireek sends a GraphQL request to Jobber from the dispatch/booking path.
// Adds: pinned X-JOBBER-GRAPHQL-VERSION, per-attempt timeout, and the shared backoff policy in ../http/retry.ts
//   - GraphQL `THROTTLED` (HTTP 200 + errors[].extensions.code): wait for the reported budget refill (or jittered backoff), retry.
//   - HTTP 429 / 503: honour Retry-After, retry. HTTP 5xx / network errors are retried ONLY when `idempotent: true`
//     (a mutation may already have been applied), so a failed write surfaces to the caller instead of duplicating.
// Errors thrown: graphql_http_<status>, graphql_throttled (budget never recovered), jobber_graphql_error_<first message>.
// [VERIFY] against Jobber's docs/sandbox: THROTTLED rejects the request BEFORE executing it (that is what makes retrying a mutation safe).

import { graphqlWithRetry, type RetryDeps, type RetryOptions } from "../http/retry.ts";
import { JOBBER_API_VERSION, JOBBER_GRAPHQL_URL } from "./jobber.ts";

// deno-lint-ignore no-explicit-any
export type JobberData = Record<string, any>;

export async function jobberGraphQL(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  opts: RetryOptions = {},
  deps: RetryDeps = {},
): Promise<JobberData | undefined> {
  const body = await graphqlWithRetry<JobberData>(
    { url: JOBBER_GRAPHQL_URL, headers: { Authorization: `Bearer ${accessToken}`, "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION }, query, variables },
    { maxAttempts: 3, maxDelayMs: 5_000, timeoutMs: 8_000, ...opts },
    deps,
  );
  if (body.errors?.length) throw new Error(`jobber_graphql_error_${body.errors[0]?.message ?? "unknown"}`);
  return body.data;
}
