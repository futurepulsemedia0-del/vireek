// Shared caller check for cron-driven synthetic functions.
// Accepts the DB cron secret (x-push-dispatch-secret) or the service-role bearer token.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAuthorizedCaller(req: Request): boolean {
  const cron = Deno.env.get("PUSH_DISPATCH_SECRET") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const headerSecret = req.headers.get("x-push-dispatch-secret") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return (cron !== "" && safeEqual(headerSecret, cron)) || (service !== "" && safeEqual(bearer, service));
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
