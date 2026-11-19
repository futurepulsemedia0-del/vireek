// supabase/functions/_shared/photo-authenticity/c2pa.ts
//
// READS C2PA Content Credentials. It never signs, never writes, never contacts a network.
//
// Parsing is done by the maintained Content Authenticity Initiative library `@contentauth/c2pa-wasm` (MIT),
// injected through `C2paDeps` so this file stays runtime-agnostic and unit-testable in Node
// (the Deno wiring is in functions/photo-provenance/index.ts).
//
// What a result means (and does not):
//  * validation "valid": the signed claim is intact and the bytes still match what was signed.
//  * trust "not_evaluated": NO trust list is configured, so who signed it was not checked. Never present this
//    as "verified origin". "trusted" only appears when operator-supplied anchors matched.
//  * No manifest says nothing about authenticity: most cameras write none, and the in-app camera re-encodes the
//    image, which removes any manifest.

import type { C2paProblem, C2paReport, C2paTrust } from "./types.ts";

/** Above this the WASM read could exceed the edge CPU budget; we skip instead of timing out. */
export const C2PA_MAX_BYTES = 12 * 1024 * 1024;

export interface C2paDeps {
  /** Resolves with the library's manifest store JSON, rejects with its error (a string such as "C2pa(JumbfNotFound)"). */
  readManifestStore: (mime: string, bytes: Uint8Array, contextJson: string) => Promise<unknown>;
  /** PEM bundle of PUBLIC trust anchors (operator supplied). Empty/undefined: signer trust is not evaluated. */
  trustAnchorsPem?: string | null;
}

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

const GENERATED_SOURCES = new Set([
  "trainedalgorithmicmedia", "compositewithtrainedalgorithmicmedia", "compositesynthetic",
  "algorithmicmedia", "datadrivenmedia", "virtualrecording", "digitalart",
]);
const CAPTURE_SOURCES = new Set(["digitalcapture", "computationalcapture", "compositecapture"]);
const EDIT_ACTIONS = new Set([
  "c2pa.edited", "c2pa.filtered", "c2pa.cropped", "c2pa.resized", "c2pa.color_adjustments", "c2pa.drawing", "c2pa.orientation",
]);
const CODE_RE = /^[A-Za-z0-9._-]{1,80}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

export function buildContextJson(trustAnchorsPem?: string | null): string {
  const pem = (trustAnchorsPem ?? "").trim();
  if (!pem) return JSON.stringify({ verify: { verify_trust: false } });
  return JSON.stringify({ verify: { verify_trust: true }, trust: { trust_anchors: pem } });
}

function emptyReport(status: C2paReport["status"]): C2paReport {
  return {
    status, validation: "unknown", trust: "not_evaluated", problems: [], statusCodes: [], manifestCount: 0,
    claimGenerator: null, signer: null, actions: [], digitalSourceTypes: [], ingredientCount: 0,
    declaresGeneratedMedia: false, declaresCapture: false, declaresEdits: false,
  };
}

function classify(code: string): C2paProblem | null {
  if (code === "signingCredential.untrusted") return null; // handled through `trust`
  if (code.startsWith("assertion.dataHash.mismatch") || code.startsWith("assertion.bmffHash.mismatch") || code.startsWith("assertion.boxesHash.mismatch")) return "asset_changed_after_signing";
  if (code.startsWith("claimSignature.")) return "signature_invalid";
  if (code === "signingCredential.expired") return "certificate_expired";
  if (code.startsWith("signingCredential.")) return "certificate_invalid";
  if (code.startsWith("timeStamp.")) return "timestamp_invalid";
  if (code.startsWith("claim.") || code.startsWith("assertion.") || code.startsWith("manifest.")) return "manifest_malformed";
  return "other";
}

/** Turns the library's manifest store JSON into the small, bounded, display-safe report we persist. */
export function normalizeManifestStore(store: unknown, trustConfigured: boolean): C2paReport {
  if (!isObj(store)) return emptyReport("error");
  const r = emptyReport("read");

  const manifests = isObj(store.manifests) ? store.manifests : {};
  r.manifestCount = Object.keys(manifests).length;
  const activeLabel = typeof store.active_manifest === "string" ? store.active_manifest : null;
  const active = activeLabel && isObj(manifests[activeLabel]) ? (manifests[activeLabel] as Obj) : null;

  const codes: string[] = [];
  const statuses = Array.isArray(store.validation_status) ? store.validation_status : [];
  for (const s of statuses.slice(0, 40)) {
    const code = isObj(s) && typeof s.code === "string" && CODE_RE.test(s.code) ? s.code : null;
    if (code && !codes.includes(code) && codes.length < 20) codes.push(code);
  }
  r.statusCodes = codes;
  const problems = new Set<C2paProblem>();
  for (const c of codes) { const p = classify(c); if (p) problems.add(p); }
  r.problems = [...problems];

  const state = typeof store.validation_state === "string" ? store.validation_state : "";
  if (state === "Invalid" || problems.size > 0) r.validation = "invalid";
  else if (state === "Valid" || state === "Trusted") r.validation = "valid";
  else r.validation = "unknown";

  let trust: C2paTrust = "not_evaluated";
  if (trustConfigured) {
    trust = state === "Trusted" ? "trusted" : "untrusted";
    if (codes.includes("signingCredential.untrusted")) trust = "untrusted";
  }
  r.trust = trust;

  if (!active) {
    r.validation = "unknown";
    return r;
  }

  r.claimGenerator = str(active.claim_generator, 100)
    ?? (Array.isArray(active.claim_generator_info) && isObj(active.claim_generator_info[0]) ? str((active.claim_generator_info[0] as Obj).name, 100) : null);
  if (isObj(active.signature_info)) {
    const si = active.signature_info;
    r.signer = {
      issuer: str(si.issuer, 100), commonName: str(si.common_name, 100), algorithm: str(si.alg, 20),
      signedAt: typeof si.time === "string" && !Number.isNaN(Date.parse(si.time)) ? new Date(Date.parse(si.time)).toISOString() : null,
    };
  }
  r.ingredientCount = Array.isArray(active.ingredients) ? Math.min(active.ingredients.length, 999) : 0;

  const actions: string[] = [];
  const sources = new Set<string>();
  const assertions = Array.isArray(active.assertions) ? active.assertions : [];
  for (const a of assertions.slice(0, 100)) {
    if (!isObj(a) || typeof a.label !== "string" || !a.label.startsWith("c2pa.actions") || !isObj(a.data)) continue;
    const list = Array.isArray(a.data.actions) ? a.data.actions : [];
    for (const act of list.slice(0, 100)) {
      if (!isObj(act)) continue;
      const name = typeof act.action === "string" && CODE_RE.test(act.action) ? act.action : null;
      if (name && !actions.includes(name) && actions.length < 20) actions.push(name);
      const dst = typeof act.digitalSourceType === "string" ? (act.digitalSourceType.split("/").pop() ?? "") : "";
      if (/^[A-Za-z0-9_-]{1,60}$/.test(dst)) sources.add(dst);
    }
  }
  r.actions = actions;
  r.digitalSourceTypes = [...sources].slice(0, 8);
  const lowered = [...sources].map((s) => s.toLowerCase());
  r.declaresGeneratedMedia = lowered.some((s) => GENERATED_SOURCES.has(s));
  r.declaresCapture = lowered.some((s) => CAPTURE_SOURCES.has(s));
  r.declaresEdits = actions.some((a) => EDIT_ACTIONS.has(a));
  return r;
}

export async function readC2pa(deps: C2paDeps | null | undefined, bytes: Uint8Array, mime: string): Promise<C2paReport> {
  if (!deps) return emptyReport("unavailable");
  if (!SUPPORTED_MIME.has(mime)) return emptyReport("unsupported_format");
  if (bytes.byteLength > C2PA_MAX_BYTES) return emptyReport("too_large");
  const trustConfigured = !!(deps.trustAnchorsPem ?? "").trim();
  try {
    const store = await deps.readManifestStore(mime, bytes, buildContextJson(deps.trustAnchorsPem));
    return normalizeManifestStore(store, trustConfigured);
  } catch (e) {
    const msg = String((e as { message?: unknown })?.message ?? e);
    if (msg.includes("JumbfNotFound") || msg.includes("ProvenanceNotFound")) return emptyReport("not_present");
    if (msg.includes("UnsupportedType")) return emptyReport("unsupported_format");
    // The raw message can echo configuration; log a bounded code only, never surface it.
    console.error("[photo-authenticity] c2pa read failed", msg.slice(0, 80).replace(/[^\w()\- ]/g, "?"));
    return emptyReport("error");
  }
}
