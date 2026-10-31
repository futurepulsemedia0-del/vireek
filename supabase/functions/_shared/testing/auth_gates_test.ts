// Auth-gate tests for cron + user edge functions.
// Run:  deno test -A supabase/functions/_shared/testing/auth_gates_test.ts
//
// The handlers are loaded WITHOUT starting a server: Deno.serve is swapped for a capture function while
// the module is imported. Only requests that must be REJECTED before any database access are sent, so no
// network / database is needed beyond fetching the npm: imports once.
// (File name ends in _test.ts on purpose: vitest only picks up *.test.ts, Deno picks up *_test.ts.)

import { assertEquals } from "jsr:@std/assert@1";

type Handler = (req: Request) => Response | Promise<Response>;

async function loadHandler(relativePath: string): Promise<Handler> {
  let captured: Handler | undefined;
  // deno-lint-ignore no-explicit-any
  const d = Deno as any;
  const original = d.serve;
  d.serve = (h: Handler) => {
    captured = h;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
  };
  try {
    await import(`${new URL(relativePath, import.meta.url).href}?t=${crypto.randomUUID()}`);
  } finally {
    d.serve = original;
  }
  if (!captured) throw new Error(`${relativePath} did not call Deno.serve`);
  return captured;
}

function setEnv(vars: Record<string, string | null>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

const BASE_ENV = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
};

const post = (headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost/fn", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

// ------------------------------------------------------------------ estimate-recovery-agent
Deno.test("estimate-recovery-agent: rejects a missing or wrong X-Cron-Secret when CRON_SECRET is set", async () => {
  setEnv({ ...BASE_ENV, CRON_SECRET: "right-secret" });
  const h = await loadHandler("../../estimate-recovery-agent/index.ts");
  assertEquals((await h(post())).status, 401);
  assertEquals((await h(post({ "X-Cron-Secret": "wrong" }))).status, 401);
  assertEquals((await h(post({ "X-Cron-Secret": "right-secre" }))).status, 401); // prefix is not enough
});

// ------------------------------------------------------------------ send-payment-reminders
Deno.test("send-payment-reminders: rejects a missing or wrong X-Cron-Secret when PAYMENT_REMINDER_CRON_SECRET is set", async () => {
  setEnv({ ...BASE_ENV, PAYMENT_REMINDER_CRON_SECRET: "right-secret" });
  const h = await loadHandler("../../send-payment-reminders/index.ts");
  assertEquals((await h(post())).status, 401);
  assertEquals((await h(post({ "X-Cron-Secret": "wrong" }))).status, 401);
});

// ------------------------------------------------------------------ money-recovered-run
Deno.test("money-recovered-run: cron header must match MONEY_RECOVERED_CRON_SECRET (fail-closed when unset)", async () => {
  const h = await loadHandler("../../money-recovered-run/index.ts");
  setEnv({ ...BASE_ENV, MONEY_RECOVERED_CRON_SECRET: "right-secret" });
  assertEquals((await h(post({ "X-Cron-Secret": "wrong" }, { action: "sweep" }))).status, 401);
  assertEquals((await h(post({ "X-Cron-Secret": "" }, { action: "sweep" }))).status, 401);
  setEnv({ MONEY_RECOVERED_CRON_SECRET: null });
  assertEquals((await h(post({ "X-Cron-Secret": "anything" }, { action: "sweep" }))).status, 401);
});

Deno.test("money-recovered-run: only POST is accepted", async () => {
  setEnv(BASE_ENV);
  const h = await loadHandler("../../money-recovered-run/index.ts");
  assertEquals((await h(new Request("http://localhost/fn", { method: "GET" }))).status, 405);
});

Deno.test("money-recovered-run: owner path rejects a request without a JWT", async () => {
  setEnv(BASE_ENV);
  const h = await loadHandler("../../money-recovered-run/index.ts");
  assertEquals((await h(post({}, { action: "send_test" }))).status, 401);
  assertEquals((await h(post({ Authorization: "Bearer not-a-jwt" }, { action: "send_test" }))).status, 401);
});

// ------------------------------------------------------------------ qbo-sync-run
Deno.test("qbo-sync-run: cron/webhook actions need the exact X-Cron-Secret (403, fail-closed when unset)", async () => {
  const h = await loadHandler("../../qbo-sync-run/index.ts");
  setEnv({ ...BASE_ENV, CRON_SECRET: "right-secret" });
  for (const action of ["cron", "webhook"]) {
    assertEquals((await h(post({}, { action }))).status, 403);
    assertEquals((await h(post({ "X-Cron-Secret": "wrong" }, { action }))).status, 403);
  }
  setEnv({ CRON_SECRET: null });
  assertEquals((await h(post({ "X-Cron-Secret": "x" }, { action: "cron" }))).status, 403);
  assertEquals((await h(post({ "X-Cron-Secret": "" }, { action: "cron" }))).status, 403);
});

Deno.test("qbo-sync-run: user actions reject a missing or invalid JWT", async () => {
  setEnv({ ...BASE_ENV, CRON_SECRET: "right-secret" });
  const h = await loadHandler("../../qbo-sync-run/index.ts");
  assertEquals((await h(post({}, { action: "run" }))).status, 401);
  assertEquals((await h(post({ Authorization: "Bearer not-a-jwt" }, { action: "run" }))).status, 401);
});

Deno.test("qbo-sync-run: a cron secret does not unlock user actions", async () => {
  setEnv({ ...BASE_ENV, CRON_SECRET: "right-secret" });
  const h = await loadHandler("../../qbo-sync-run/index.ts");
  assertEquals((await h(post({ "X-Cron-Secret": "right-secret" }, { action: "run" }))).status, 401);
});
