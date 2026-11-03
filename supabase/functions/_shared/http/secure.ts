// _shared/http/secure.ts — ONE composable wrapper: method gate -> CORS -> request-id -> rate limit -> auth ->
// bounded body -> validation -> handler, with standardized errors and structured redacted logs.

import {
  checkSharedSecret, corsHeadersFor, errorResponse, HttpError, makeLogger, newRequestId, readJsonBody, validate,
  type CorsOptions, type LogFn, type Parser,
} from "./core.ts";
import { rateLimitedError, type RateLimiter } from "./rateLimit.ts";

export interface Principal { kind: "user" | "service" | "webhook" | "anonymous"; userId?: string; tenantId?: string; roles?: string[] }

export interface AuthContext { req: Request; rawBody: string | null; requestId: string }
export type AuthStrategy = (ctx: AuthContext) => Promise<Principal>;

/** Cron / pg_net / internal callers: FAIL-CLOSED shared secret in a header. */
export function sharedSecretAuth(header: string, getSecret: () => string | undefined): AuthStrategy {
  return async ({ req }) => {
    if (!checkSharedSecret(getSecret(), req.headers.get(header))) throw new HttpError("unauthorized", "Unauthorized.");
    return { kind: "service" };
  };
}

export interface UserDeps {
  getUser(jwt: string): Promise<{ id: string } | null>;
  /** Resolves the tenant (account owner) and roles for the user; null = no active membership. */
  resolveTenant(userId: string): Promise<{ tenantId: string; roles: string[] } | null>;
}

/** End-user JWT + tenant resolution + optional role requirement. Never trusts a tenant id from the client. */
export function jwtAuth(deps: UserDeps, opts: { anyOfRoles?: readonly string[] } = {}): AuthStrategy {
  return async ({ req }) => {
    const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
    if (!m) throw new HttpError("unauthorized", "Missing bearer token.");
    const user = await deps.getUser(m[1]);
    if (!user) throw new HttpError("unauthorized", "Invalid or expired session.");
    const t = await deps.resolveTenant(user.id);
    if (!t) throw new HttpError("forbidden", "No active membership.");
    if (opts.anyOfRoles && !t.roles.some((r) => opts.anyOfRoles!.includes(r))) throw new HttpError("forbidden", "Insufficient role.");
    return { kind: "user", userId: user.id, tenantId: t.tenantId, roles: t.roles };
  };
}

/** Webhook: the strategy receives the RAW body (needed for the signature) and must throw HttpError on failure. */
export function webhookAuth(verify: (ctx: AuthContext) => Promise<void>): AuthStrategy {
  return async (ctx) => { await verify(ctx); return { kind: "webhook" }; };
}

export const publicAuth: AuthStrategy = async () => ({ kind: "anonymous" });

export interface SecureOptions<T> {
  name: string;
  methods?: readonly string[];
  auth: AuthStrategy;
  cors?: CorsOptions;            // omit for server-to-server endpoints: no CORS headers are emitted
  rateLimit?: { limiter: RateLimiter; limit: number; windowSeconds: number; key?: (req: Request, p: Principal | null) => string };
  /** Mandatory for anonymous endpoints (enforced at construction). */
  maxBodyBytes?: number;
  parser?: Parser<T>;
  log?: (line: string) => void;
}

export interface HandlerContext<T> { req: Request; principal: Principal; input: T; rawBody: string | null; requestId: string; log: LogFn }

function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim().slice(0, 64);
}

export function secure<T = undefined>(opts: SecureOptions<T>, handler: (c: HandlerContext<T>) => Promise<Response>): (req: Request) => Promise<Response> {
  assertPublicEndpointSafe(opts);
  const methods = opts.methods ?? ["POST"];
  const maxBody = opts.maxBodyBytes ?? 256_000;
  return async (req) => {
    const requestId = newRequestId(req);
    const log = makeLogger(opts.name, requestId, opts.log);
    const started = Date.now();
    const cors = opts.cors ? corsHeadersFor(req, opts.cors) : {};
    const respond = (res: Response) => {
      const h = new Headers(res.headers);
      h.set("X-Request-Id", requestId);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    };
    try {
      if (req.method === "OPTIONS" && opts.cors) return respond(new Response(null, { status: 204 }));
      if (!methods.includes(req.method)) throw new HttpError("method_not_allowed", "Method not allowed.", null, { Allow: methods.join(", ") });

      // Rate limit BEFORE auth so credential stuffing is throttled; keyed by IP (or principal via key()).
      if (opts.rateLimit) {
        const key = `${opts.name}:${opts.rateLimit.key ? opts.rateLimit.key(req, null) : clientIp(req)}`;
        const r = await opts.rateLimit.limiter.hit(key, opts.rateLimit.limit, opts.rateLimit.windowSeconds);
        if (!r.allowed) throw rateLimitedError(r.retryAfter);
      }

      let rawBody: string | null = null;
      let json: unknown;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const b = await readJsonBody(req.clone(), maxBody).catch((e) => { if (opts.parser || !(e instanceof HttpError && e.code === "bad_request")) throw e; return null; });
        if (b) { rawBody = b.raw; json = b.json; }
        else rawBody = await req.clone().text(); // non-JSON body (e.g. form-encoded webhooks): handler decides
      }

      const principal = await opts.auth({ req, rawBody, requestId });
      const input = (opts.parser ? validate(opts.parser, json) : (json as T));
      const res = await handler({ req, principal, input, rawBody, requestId, log });
      log("request_ok", { status: res.status, ms: Date.now() - started, principal: principal.kind, tenant: principal.tenantId });
      return respond(res);
    } catch (e) {
      if (e instanceof HttpError) {
        log("request_rejected", { code: e.code, ms: Date.now() - started });
        return respond(errorResponse(e, requestId));
      }
      log("request_failed", { error: e instanceof Error ? e.message : "unknown", ms: Date.now() - started });
      return respond(errorResponse(new HttpError("internal", "Internal error."), requestId));
    }
  };
}

/** Guard used by the CI rule and at construction time: anonymous endpoints MUST be rate limited and validated. */
export function assertPublicEndpointSafe(o: { auth: AuthStrategy; rateLimit?: unknown; parser?: unknown }): void {
  if (o.auth === publicAuth && (!o.rateLimit || !o.parser)) throw new Error("public endpoints require rateLimit and parser");
}
