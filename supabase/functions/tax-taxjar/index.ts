import { adminClient, authenticate, corsHeaders, json } from "../_shared/bank/http.ts";

// POST { action: "connect", api_key }            -> validates the key, stores it server-side
// POST { action: "sync_rates", postal_codes[] }  -> pulls TaxJar rates into tax_jurisdictions
// POST { action: "disconnect" }                  -> deletes the stored key
// The API key is never returned to the browser.

const TAXJAR = "https://api.taxjar.com/v2";
const MAX_ZIPS = 25;

interface TaxJarRate {
  zip: string;
  state?: string;
  state_rate?: string;
  county?: string;
  county_rate?: string;
  city?: string;
  city_rate?: string;
  combined_district_rate?: string;
}

async function taxjarRate(apiKey: string, zip: string): Promise<TaxJarRate | null> {
  const res = await fetch(`${TAXJAR}/rates/${zip}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("TaxJar rejected the API key.");
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`TaxJar error (${res.status}).`);
  const body = await res.json();
  return (body?.rate as TaxJarRate) ?? null;
}

const pctOf = (v: string | undefined) => Math.round(Number(v ?? 0) * 100 * 10000) / 10000; // "0.0625" -> 6.25

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = adminClient();
    const caller = await authenticate(req, db);
    if (caller instanceof Response) return caller;
    if (!caller.canManage) return json({ error: "You need the View Billing permission." }, 403);

    const body = await req.json().catch(() => ({}));
    const ownerId = caller.ownerId;

    if (body.action === "connect") {
      const apiKey = String(body.api_key ?? "").trim();
      if (apiKey.length < 8 || apiKey.length > 200) return json({ error: "Enter a valid TaxJar API key." }, 400);
      try {
        await taxjarRate(apiKey, "90210"); // cheap auth probe
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Could not reach TaxJar." }, 400);
      }
      const { error } = await db.from("tax_provider_credentials").upsert(
        { user_id: ownerId, provider: "taxjar", api_key: apiKey, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (error) throw error;
      await db.from("tax_settings").upsert({ user_id: ownerId, provider: "taxjar", taxjar_connected: true }, { onConflict: "user_id" });
      return json({ success: true });
    }

    if (body.action === "disconnect") {
      await db.from("tax_provider_credentials").delete().eq("user_id", ownerId);
      await db.from("tax_settings").upsert({ user_id: ownerId, provider: "manual", taxjar_connected: false }, { onConflict: "user_id" });
      return json({ success: true });
    }

    if (body.action === "sync_rates") {
      const zips: string[] = [...new Set<string>((Array.isArray(body.postal_codes) ? body.postal_codes : []).map(String))]
        .filter((z) => /^\d{5}$/.test(z));
      if (zips.length === 0) return json({ error: "Provide at least one 5-digit ZIP code." }, 400);
      if (zips.length > MAX_ZIPS) return json({ error: `Sync at most ${MAX_ZIPS} ZIP codes at a time.` }, 400);

      const { data: cred } = await db.from("tax_provider_credentials").select("api_key").eq("user_id", ownerId).maybeSingle();
      if (!cred?.api_key) return json({ error: "Connect TaxJar first." }, 400);

      // Group ZIPs by (level, state, name, rate) so one jurisdiction row covers many ZIPs.
      const groups = new Map<string, { level: string; state: string; name: string; rate: number; zips: string[] }>();
      const skipped: string[] = [];
      for (const zip of zips) {
        const r = await taxjarRate(cred.api_key, zip);
        if (!r || !r.state) { skipped.push(zip); continue; }
        const parts: [string, string, number][] = [
          ["state", `${r.state} state tax`, pctOf(r.state_rate)],
          ["county", `${r.county ?? "County"} county tax`, pctOf(r.county_rate)],
          ["city", `${r.city ?? "City"} city tax`, pctOf(r.city_rate)],
          ["district", `${r.city ?? r.county ?? r.state} special districts`, pctOf(r.combined_district_rate)],
        ];
        for (const [level, name, rate] of parts) {
          if (rate <= 0) continue;
          const key = `${level}|${r.state}|${name.toLowerCase()}|${rate}`;
          const g = groups.get(key) ?? { level, state: r.state, name, rate, zips: [] };
          g.zips.push(zip);
          groups.set(key, g);
        }
      }

      // Merge with rows synced earlier for the same states so a partial sync never drops ZIPs,
      // then replace those rows (PostgREST cannot upsert on a partial/expression index).
      const states = [...new Set([...groups.values()].map((g) => g.state))];
      if (states.length > 0) {
        const { data: existing } = await db.from("tax_jurisdictions").select("level,state,name,rate_percent,postal_codes")
          .eq("user_id", ownerId).eq("source", "taxjar").in("state", states);
        for (const e of existing ?? []) {
          const key = `${e.level}|${e.state}|${String(e.name).toLowerCase()}|${Number(e.rate_percent)}`;
          const g = groups.get(key) ?? { level: e.level, state: e.state, name: e.name, rate: Number(e.rate_percent), zips: [] };
          g.zips = [...new Set([...(e.postal_codes ?? []), ...g.zips])];
          groups.set(key, g);
        }
      }
      const rows = [...groups.values()].map((g) => ({
        user_id: ownerId, level: g.level, state: g.state, name: g.name, rate_percent: g.rate,
        postal_codes: g.level === "state" ? [] : g.zips, source: "taxjar", active: true,
      }));
      if (rows.length > 0) {
        const { error: delErr } = await db.from("tax_jurisdictions").delete()
          .eq("user_id", ownerId).eq("source", "taxjar").in("state", states);
        if (delErr) throw delErr;
        const { error } = await db.from("tax_jurisdictions").insert(rows);
        if (error) throw error;
      }
      await db.from("tax_settings").upsert({ user_id: ownerId, taxjar_last_synced_at: new Date().toISOString() }, { onConflict: "user_id" });
      return json({ success: true, synced: rows.length, skipped });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(JSON.stringify({ event: "tax_taxjar_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: e instanceof Error ? e.message : "Tax provider request failed." }, 500);
  }
});
