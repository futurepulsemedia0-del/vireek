// supabase/functions/fabric-ingest/index.ts
//
// Vireek Data Fabric — universal ingestion gateway.
//
// Any external system (CRM, ERP, accounting, OEM, IoT, telematics, maps,
// payments, inventory, phone, email, calendar, insurance, warranty,
// government, marketplace) POSTs records here. Each record is validated,
// optionally translated with the connection's field mapping, landed
// idempotently in `fabric_records`, then identity-resolved and projected into
// the canonical service graph by the `fabric_apply_record` database function.
//
// Auth: per-connection ingest key (Authorization: Bearer vfk_...). Only the
// SHA-256 hash of the key is stored (see fabric_connections.ingest_key_hash).
//
// Request body:
//   { "records": [
//       {
//         "entity": "customer",              // customer|property|equipment|technician|part|job|vendor|payment|call|warranty
//         "external_id": "crm-1042",         // the source system's id (idempotency key)
//         "data": { "name": "Ana Silva", "email": "ana@example.com", "address": "12 Oak St" },
//         "raw": { ...provider payload... }, // optional; translated with the connection's field_mapping[entity]
//         "refs": [ { "entity": "property", "external_id": "p-9", "relation": "has_property" } ],
//         "occurred_at": "2027-03-01T10:00:00Z"  // optional; older events never overwrite newer ones
//       }
//   ] }
//
// Deploy:
//   supabase functions deploy fabric-ingest --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const ENTITIES = [
  "customer", "property", "equipment", "technician", "part",
  "job", "vendor", "payment", "call", "warranty",
] as const;
type Entity = (typeof ENTITIES)[number];

// Parents first, so references resolve in a single pass for well-ordered batches.
const ENTITY_ORDER: Record<Entity, number> = {
  customer: 0, property: 1, vendor: 2, technician: 3, equipment: 4,
  part: 5, warranty: 6, job: 7, call: 8, payment: 9,
};

const MAX_BODY_BYTES = 1_000_000;
const MAX_RECORDS = 200;
const MAX_DATA_CHARS = 64_000;
const MAX_REFS = 25;
const RELATION_RE = /^[a-z_]{2,40}$/;
const FIELD_RE = /^[a-z_]{1,40}$/;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deterministic JSON (sorted keys) so the same payload always hashes the same.
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// Reads "a.b[0].c" style paths.
function getPath(obj: unknown, path: string): unknown {
  const parts = path.match(/[^.[\]]+/g);
  if (!parts) return undefined;
  let cur: unknown = obj;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isPlainObject(cur)) {
      cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function applyMapping(raw: Record<string, unknown>, mapping: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(mapping)) return out;
  for (const [field, path] of Object.entries(mapping)) {
    if (!FIELD_RE.test(field) || typeof path !== "string") continue;
    const value = getPath(raw, path);
    if (isScalar(value)) out[field] = value;
  }
  return out;
}

function cleanId(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s.length >= 1 && s.length <= 200 ? s : null;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  connector_key: string;
  status: string;
  entities: string[] | null;
  field_mapping: Record<string, unknown> | null;
}

interface NormalizedRecord {
  index: number;
  entity: Entity;
  externalId: string;
  data: Record<string, unknown>;
  refs: { entity: Entity; external_id: string; relation?: string }[];
  occurredAt: string | null;
}

type Normalized = { ok: true; value: NormalizedRecord } | { ok: false; error: string };

function normalizeRecord(input: unknown, index: number, conn: ConnectionRow): Normalized {
  if (!isPlainObject(input)) return { ok: false, error: "Record must be an object." };

  const entity = input.entity;
  if (typeof entity !== "string" || !(ENTITIES as readonly string[]).includes(entity)) {
    return { ok: false, error: `Unknown entity. Use one of: ${ENTITIES.join(", ")}.` };
  }
  const allowed = conn.entities ?? [];
  if (allowed.length > 0 && !allowed.includes(entity)) {
    return { ok: false, error: `Entity "${entity}" is not enabled for this connection.` };
  }

  const mapping = isPlainObject(conn.field_mapping) ? conn.field_mapping[entity] : undefined;
  let mapped: Record<string, unknown> = {};
  if (input.raw !== undefined) {
    if (!isPlainObject(input.raw)) return { ok: false, error: "`raw` must be an object." };
    mapped = applyMapping(input.raw, mapping);
  }
  if (input.data !== undefined && !isPlainObject(input.data)) {
    return { ok: false, error: "`data` must be an object." };
  }

  const data: Record<string, unknown> = { ...mapped, ...(isPlainObject(input.data) ? input.data : {}) };

  let externalId = cleanId(input.external_id);
  if (!externalId && typeof data.external_id !== "undefined") externalId = cleanId(data.external_id);
  delete data.external_id;
  if (!externalId) return { ok: false, error: "`external_id` is required (1–200 characters)." };

  if (Object.keys(data).length === 0) return { ok: false, error: "Record has no data (provide `data`, or `raw` with a field mapping)." };
  if (JSON.stringify(data).length > MAX_DATA_CHARS) return { ok: false, error: "Record data exceeds 64 KB." };

  const refs: NormalizedRecord["refs"] = [];
  if (input.refs !== undefined) {
    if (!Array.isArray(input.refs) || input.refs.length > MAX_REFS) {
      return { ok: false, error: `\`refs\` must be an array of at most ${MAX_REFS} items.` };
    }
    for (const ref of input.refs) {
      if (!isPlainObject(ref)) return { ok: false, error: "Each ref must be an object." };
      const refEntity = ref.entity;
      const refId = cleanId(ref.external_id);
      if (typeof refEntity !== "string" || !(ENTITIES as readonly string[]).includes(refEntity) || !refId) {
        return { ok: false, error: "Each ref needs a valid `entity` and `external_id`." };
      }
      const item: { entity: Entity; external_id: string; relation?: string } = {
        entity: refEntity as Entity,
        external_id: refId,
      };
      if (typeof ref.relation === "string" && RELATION_RE.test(ref.relation)) item.relation = ref.relation;
      refs.push(item);
    }
  }

  let occurredAt: string | null = null;
  if (input.occurred_at !== undefined && input.occurred_at !== null) {
    const t = typeof input.occurred_at === "string" ? Date.parse(input.occurred_at) : NaN;
    if (Number.isNaN(t)) return { ok: false, error: "`occurred_at` must be an ISO-8601 date string." };
    occurredAt = new Date(t).toISOString();
  }

  return { ok: true, value: { index, entity: entity as Entity, externalId, data, refs, occurredAt } };
}

interface ResultItem {
  index: number;
  entity?: string;
  external_id?: string;
  status: "applied" | "unchanged" | "stale" | "failed" | "rejected";
  node_id?: string;
  unresolved_refs?: number;
  error?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // ---- Authenticate the ingest key ---------------------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!rawKey.startsWith("vfk_")) {
      return json({ error: "Missing or invalid Authorization header. Use: Authorization: Bearer vfk_..." }, 401);
    }

    const { data: connData, error: connError } = await admin
      .from("fabric_connections")
      .select("id, user_id, connector_key, status, entities, field_mapping")
      .eq("ingest_key_hash", await sha256Hex(rawKey))
      .maybeSingle();
    if (connError) {
      console.error(JSON.stringify({ event: "fabric_conn_lookup_failed", error: connError.message }));
      return json({ error: "Something went wrong." }, 500);
    }
    if (!connData) return json({ error: "Invalid ingest key." }, 401);
    const conn = connData as ConnectionRow;
    if (conn.status !== "active") return json({ error: "This connection is paused." }, 403);

    // ---- Parse + bound the body --------------------------------------------
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json({ error: "Payload too large (max 1 MB)." }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "Payload too large (max 1 MB)." }, 413);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "Body must be valid JSON." }, 400);
    }
    const records = Array.isArray(body) ? body : isPlainObject(body) ? body.records : undefined;
    if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS) {
      return json({ error: `Send { "records": [...] } with 1–${MAX_RECORDS} records.` }, 400);
    }

    // ---- Validate / normalize ----------------------------------------------
    const results: ResultItem[] = [];
    const valid: NormalizedRecord[] = [];
    records.forEach((rec, index) => {
      const n = normalizeRecord(rec, index, conn);
      if (n.ok) valid.push(n.value);
      else results.push({ index, status: "rejected", error: n.error });
    });
    valid.sort((a, b) => ENTITY_ORDER[a.entity] - ENTITY_ORDER[b.entity] || a.index - b.index);

    // ---- Land + apply -------------------------------------------------------
    for (const rec of valid) {
      const base = { index: rec.index, entity: rec.entity, external_id: rec.externalId };
      try {
        const payloadHash = await sha256Hex(stableStringify({ d: rec.data, r: rec.refs }));

        const { data: existing, error: existingError } = await admin
          .from("fabric_records")
          .select("id, payload_hash, status, occurred_at")
          .eq("connection_id", conn.id)
          .eq("entity", rec.entity)
          .eq("external_id", rec.externalId)
          .maybeSingle();
        if (existingError) throw new Error(existingError.message);

        if (existing && existing.payload_hash === payloadHash && existing.status === "applied") {
          results.push({ ...base, status: "unchanged" });
          continue;
        }
        if (
          existing?.occurred_at && rec.occurredAt &&
          Date.parse(rec.occurredAt) < Date.parse(existing.occurred_at as string)
        ) {
          results.push({ ...base, status: "stale" });
          continue;
        }

        const { data: upserted, error: upsertError } = await admin
          .from("fabric_records")
          .upsert(
            {
              user_id: conn.user_id,
              connection_id: conn.id,
              entity: rec.entity,
              external_id: rec.externalId,
              payload_hash: payloadHash,
              data: rec.data,
              refs: rec.refs,
              occurred_at: rec.occurredAt,
              status: "pending",
              attempts: 0,
              error: null,
              received_at: new Date().toISOString(),
            },
            { onConflict: "connection_id,entity,external_id" },
          )
          .select("id")
          .single();
        if (upsertError || !upserted) throw new Error(upsertError?.message ?? "Could not store record.");

        const { data: applied, error: applyError } = await admin.rpc("fabric_apply_record", {
          p_record_id: upserted.id,
        });
        if (applyError) throw new Error(applyError.message);

        const outcome = (applied ?? {}) as { status?: string; node_id?: string; unresolved_refs?: number; error?: string };
        if (outcome.status === "applied") {
          results.push({ ...base, status: "applied", node_id: outcome.node_id, unresolved_refs: outcome.unresolved_refs ?? 0 });
        } else {
          results.push({ ...base, status: "failed", error: outcome.error ?? "Could not apply record." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : "Unexpected error.";
        console.error(JSON.stringify({ event: "fabric_record_failed", connection: conn.id, entity: rec.entity, error: message }));
        results.push({ ...base, status: "failed", error: message });
      }
    }

    results.sort((a, b) => a.index - b.index);
    const count = (s: ResultItem["status"]) => results.filter((r) => r.status === s).length;
    const failed = count("failed");
    const rejected = count("rejected");
    const firstError = results.find((r) => r.status === "failed" || r.status === "rejected")?.error ?? null;

    await admin
      .from("fabric_connections")
      .update({ last_event_at: new Date().toISOString(), last_error: firstError })
      .eq("id", conn.id);

    return json(
      {
        ok: failed + rejected === 0,
        received: records.length,
        applied: count("applied"),
        unchanged: count("unchanged"),
        stale: count("stale"),
        failed,
        rejected,
        results,
      },
      failed + rejected === 0 ? 200 : 207,
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "fabric_ingest_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong." }, 500);
  }
});
