import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Daily cron (see migration header). Stores USD-based rates in fx_rates.
// Default source: open.er-api.com (free, no key; its terms require attribution:
// "Rates By Exchange Rate API"). Swap provider with FX_RATES_URL (same JSON shape).
const KEEP = new Set(["USD","EUR","GBP","CAD","AUD","NZD","CHF","SEK","NOK","DKK","PLN","CZK","HUF","AED","SAR","QAR","TRY","ILS","EGP","ZAR","INR","SGD","HKD","JPY","KRW","MXN","BRL"]);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("FX_CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Unauthorized." }, 401);

  const url = Deno.env.get("FX_RATES_URL") ?? "https://open.er-api.com/v6/latest/USD";
  let payload: { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return json({ error: `rates_http_${res.status}` }, 502);
    payload = await res.json();
  } catch (e) {
    return json({ error: "rates_fetch_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
  if (payload.result && payload.result !== "success") return json({ error: "rates_provider_error" }, 502);

  const rateDate = (payload.time_last_update_unix ? new Date(payload.time_last_update_unix * 1000) : new Date()).toISOString().slice(0, 10);
  const rows = Object.entries(payload.rates ?? {})
    .filter(([code, rate]) => KEEP.has(code) && code !== "USD" && Number.isFinite(rate) && rate > 0)
    .map(([quote_currency, rate]) => ({ base_currency: "USD", quote_currency, rate, rate_date: rateDate, source: "open_er_api" }));
  // Sanity guard: a truncated/garbled response must never overwrite good data.
  if (rows.length < 15) return json({ error: "rates_incomplete", count: rows.length }, 502);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { error } = await admin.from("fx_rates").upsert(rows, { onConflict: "base_currency,quote_currency,rate_date" });
  if (error) return json({ error: "rates_store_failed", detail: error.message }, 500);
  return json({ ok: true, rate_date: rateDate, count: rows.length });
});
