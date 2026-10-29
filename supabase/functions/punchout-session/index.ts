// punchout-session — dashboard-called API for supplier cXML PunchOut connections and sessions.
// Requires a signed-in owner/admin (inventory_can_manage). Shared secrets are AES-GCM encrypted at rest
// and are never returned to the browser.
//
// Body: { action, ... }
//   save_connection { vendor_id, setup_url, buyer_identity, sender_identity, supplier_identity,
//                     buyer_domain?, sender_domain?, supplier_domain?, environment?, currency?,
//                     enabled?, shared_secret? }       -> { connection }
//   test_connection { connection_id }                   -> { ok, message }
//   start           { connection_id, job_id?, destination_location_id? } -> { session_id, start_url }
//
// Deploy:  supabase functions deploy punchout-session
// Secrets: PUNCHOUT_ENCRYPTION_KEY (openssl rand -base64 32), SITE_URL (optional)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { assertSafeSupplierUrl, buildSetupRequest, CxmlError, parseSetupResponse } from "../_shared/punchout/cxml.ts";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../_shared/punchout/security.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[\x20-\x7E]{1,120}$/; // printable ASCII, as cXML identities are
const DOMAIN = /^[A-Za-z0-9_.-]{1,60}$/;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

// Database messages raised on purpose by our RPCs are safe to show; anything else is not.
const SAFE = [
  "Not allowed", "Unknown PunchOut connection", "turned off", "shared secret", "Supplier is inactive", "Unknown job",
  "Unknown delivery location", "Too many PunchOut sessions",
];
const safeDb = (m: string | undefined) => SAFE.find((k) => (m ?? "").includes(k)) ? (m as string).slice(0, 200) : "Request could not be processed.";

interface Conn {
  id: string; user_id: string; vendor_id: string; environment: "test" | "production"; setup_url: string;
  buyer_domain: string; buyer_identity: string; sender_domain: string; sender_identity: string;
  supplier_domain: string; supplier_identity: string; currency: string; enabled: boolean;
}

async function sendSetup(admin: ReturnType<typeof createClient>, conn: Conn, cookie: string, user: { email?: string | null; name?: string | null }, returnUrl: string) {
  const { data: sec } = await admin.from("supplier_punchout_secrets").select("encrypted").eq("connection_id", conn.id).maybeSingle();
  if (!sec) throw new CxmlError("Add the shared secret for this connection first");
  const secret = await decryptSecret(sec.encrypted as string);
  const url = assertSafeSupplierUrl(conn.setup_url);
  const body = buildSetupRequest({
    payloadId: `${Date.now()}.${randomToken(8)}@vireek.com`,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    buyer: { domain: conn.buyer_domain, identity: conn.buyer_identity },
    sender: { domain: conn.sender_domain, identity: conn.sender_identity, sharedSecret: secret, userAgent: "Vireek Procurement 1.0" },
    supplier: { domain: conn.supplier_domain, identity: conn.supplier_identity },
    buyerCookie: cookie,
    returnUrl,
    deploymentMode: conn.environment,
    userEmail: user.email,
    userName: user.name,
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(url, {
      method: "POST", body, redirect: "manual", signal: ctl.signal,
      headers: { "Content-Type": "text/xml; charset=UTF-8", Accept: "text/xml, application/xml" },
    });
    if (res.status >= 300 && res.status < 400) throw new CxmlError("The supplier's PunchOut URL redirected; use the final URL");
    if (!res.ok && res.status !== 400 && res.status !== 401 && res.status !== 403) throw new CxmlError(`The supplier's server answered HTTP ${res.status}`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new CxmlError("The supplier's reply was too large"); }
      chunks.push(value);
    }
    text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c])));
  } catch (e) {
    if (e instanceof CxmlError) throw e;
    throw new CxmlError(ctl.signal.aborted ? "The supplier's server did not answer in time" : "Could not reach the supplier's PunchOut server");
  } finally {
    clearTimeout(timer);
  }
  let parsed;
  try { parsed = parseSetupResponse(text); } catch { throw new CxmlError("The supplier's reply was not valid cXML"); }
  if (!parsed.ok) throw new CxmlError(parsed.code >= 400 ? `The supplier refused the request (${parsed.code} ${parsed.text})`.slice(0, 250) : "The supplier did not return a start page");
  return parsed.startUrl as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(null, 200);
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "", anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anon || !serviceKey) return json({ error: "Server misconfiguration." }, 500);
  if (!authHeader) return json({ error: "Not authenticated." }, 401);

  const caller = createClient(supabaseUrl, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return json({ error: "Not authenticated." }, 401);
  const { data: ownerId } = await caller.rpc("get_account_owner_id");
  const { data: canManage } = await caller.rpc("inventory_can_manage");
  if (!ownerId) return json({ error: "Could not resolve your account." }, 500);
  if (canManage !== true) return json({ error: "Only owners and admins can manage PunchOut." }, 403);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const action = String(body?.action ?? "");
  const ownConnection = async (id: unknown): Promise<Conn | null> => {
    if (typeof id !== "string" || !uuid.test(id)) return null;
    const { data } = await admin.from("supplier_punchout_connections").select("*").eq("id", id).eq("user_id", ownerId).maybeSingle();
    return (data as Conn | null) ?? null;
  };
  const returnUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/punchout-return`;
  const userInfo = { email: user.email ?? null, name: (user.user_metadata?.full_name as string | undefined) ?? null };

  try {
    if (action === "save_connection") {
      if (typeof body.vendor_id !== "string" || !uuid.test(body.vendor_id)) return json({ error: "Choose a supplier." }, 400);
      const { data: vendor } = await admin.from("inventory_vendors").select("id").eq("id", body.vendor_id).eq("user_id", ownerId).maybeSingle();
      if (!vendor) return json({ error: "Unknown supplier." }, 400);

      const str = (k: string, re: RegExp, label: string, dflt?: string) => {
        const v = String(body[k] ?? dflt ?? "").trim();
        if (!re.test(v)) throw new CxmlError(`${label} is missing or contains unsupported characters.`);
        return v;
      };
      const setupUrl = assertSafeSupplierUrl(String(body.setup_url ?? ""));
      const row = {
        user_id: ownerId, vendor_id: body.vendor_id, protocol: "cxml", setup_url: setupUrl,
        buyer_identity: str("buyer_identity", IDENT, "Your buyer identity"),
        sender_identity: str("sender_identity", IDENT, "Your sender identity"),
        supplier_identity: str("supplier_identity", IDENT, "The supplier identity"),
        buyer_domain: str("buyer_domain", DOMAIN, "Buyer domain", "NetworkID"),
        sender_domain: str("sender_domain", DOMAIN, "Sender domain", "NetworkID"),
        supplier_domain: str("supplier_domain", DOMAIN, "Supplier domain", "NetworkID"),
        environment: body.environment === "production" ? "production" : "test",
        currency: /^[A-Za-z]{3}$/.test(String(body.currency ?? "USD")) ? String(body.currency ?? "USD").toUpperCase() : "USD",
        enabled: body.enabled !== false,
      };
      const secretIn = typeof body.shared_secret === "string" ? body.shared_secret.trim() : "";
      if (secretIn && (secretIn.length < 4 || secretIn.length > 200)) return json({ error: "The shared secret must be 4–200 characters." }, 400);

      const { data: existing } = await admin.from("supplier_punchout_connections").select("id, secret_set").eq("vendor_id", body.vendor_id).eq("user_id", ownerId).maybeSingle();
      if (!existing && !secretIn) return json({ error: "Enter the shared secret your supplier gave you." }, 400);

      const { data: saved, error } = await admin.from("supplier_punchout_connections")
        .upsert({ ...row, secret_set: Boolean(existing?.secret_set) || Boolean(secretIn) }, { onConflict: "vendor_id" })
        .select("id, vendor_id, environment, setup_url, buyer_domain, buyer_identity, sender_domain, sender_identity, supplier_domain, supplier_identity, currency, enabled, secret_set, last_tested_at, last_test_ok, last_test_message")
        .single();
      if (error || !saved) return json({ error: "Could not save the connection." }, 400);
      if (secretIn) {
        const { error: e2 } = await admin.from("supplier_punchout_secrets")
          .upsert({ connection_id: saved.id, user_id: ownerId, encrypted: await encryptSecret(secretIn), updated_at: new Date().toISOString() }, { onConflict: "connection_id" });
        if (e2) return json({ error: "Could not store the shared secret." }, 500);
      }
      return json({ connection: saved });
    }

    if (action === "test_connection") {
      const conn = await ownConnection(body.connection_id);
      if (!conn) return json({ error: "Unknown connection." }, 404);
      let ok = false, message = "";
      try {
        await sendSetup(admin, conn, randomToken(32), userInfo, returnUrl);
        ok = true; message = "Connected. The supplier returned a start page.";
      } catch (e) {
        message = e instanceof CxmlError ? e.message : "Test failed.";
      }
      await admin.from("supplier_punchout_connections").update({ last_tested_at: new Date().toISOString(), last_test_ok: ok, last_test_message: message.slice(0, 300) }).eq("id", conn.id);
      return json({ ok, message });
    }

    if (action === "start") {
      const conn = await ownConnection(body.connection_id);
      if (!conn) return json({ error: "Unknown connection." }, 404);
      const jobId = typeof body.job_id === "string" && uuid.test(body.job_id) ? body.job_id : null;
      const destId = typeof body.destination_location_id === "string" && uuid.test(body.destination_location_id) ? body.destination_location_id : null;

      const cookie = randomToken(32);
      const { data: sessionId, error: bErr } = await caller.rpc("punchout_begin_session", {
        p_connection: conn.id, p_cookie_hash: await sha256Hex(cookie), p_job: jobId, p_dest: destId,
      });
      if (bErr || !sessionId) return json({ error: safeDb(bErr?.message) }, 400);

      try {
        const startUrl = await sendSetup(admin, conn, cookie, userInfo, returnUrl);
        await admin.from("supplier_punchout_sessions").update({ status: "started" }).eq("id", sessionId).eq("status", "pending");
        return json({ session_id: sessionId, start_url: startUrl });
      } catch (e) {
        const message = e instanceof CxmlError ? e.message : "Could not start the PunchOut session.";
        await admin.from("supplier_punchout_sessions").update({ status: "failed", error_message: message.slice(0, 300) }).eq("id", sessionId);
        return json({ error: message }, 502);
      }
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof CxmlError) return json({ error: e.message }, 400);
    return json({ error: "Internal error." }, 500);
  }
});
