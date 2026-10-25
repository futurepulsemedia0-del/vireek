// supabase/functions/_shared/wallet/service.ts
// Glue shared by wallet-pass / wallet-issue / wallet-sync: load a pass payload, render Apple + Google output.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildPkpass, defaultAssets } from "./applePkpass.ts";
import { decodeB64Env, type WalletEnv } from "./config.ts";
import { ensureClass, patchObject, saveToWalletUrl, upsertObject, type GoogleResult } from "./googleWallet.ts";
import { buildPassModel, googleClassId, googleObjectId, toApplePassJson, toGoogleObject, type PassModel, type PassPayload } from "./passModel.ts";

export async function loadPayload(admin: SupabaseClient, passId: string): Promise<PassPayload | null> {
  const { data, error } = await admin.rpc("wallet_pass_payload", { p_pass_id: passId });
  if (error) throw new Error(`wallet_pass_payload: ${error.message}`);
  return (data as PassPayload | null) ?? null;
}

export const landingUrl = (env: WalletEnv, shareToken: string) => `${env.linkBase}/${shareToken}`;

export async function renderApple(env: WalletEnv, payload: PassPayload, now = new Date()): Promise<{ bytes: Uint8Array; model: PassModel }> {
  if (!env.apple) throw new Error("APPLE_NOT_CONFIGURED");
  const model = buildPassModel(payload, now);
  const json = toApplePassJson(model, payload.pass.auth_token, env.apple);
  const assets = defaultAssets(model.colors.bg, {
    icon: decodeB64Env(Deno.env.get("WALLET_ICON_PNG_B64")),
    logo: decodeB64Env(Deno.env.get("WALLET_LOGO_PNG_B64")),
  });
  return { bytes: await buildPkpass(json, assets, env.apple), model };
}

export function googleObject(env: WalletEnv, payload: PassPayload, now = new Date()): Record<string, unknown> {
  if (!env.google) throw new Error("GOOGLE_NOT_CONFIGURED");
  const model = buildPassModel(payload, now);
  const ids = { classId: googleClassId(env.google.issuerId, payload.pass.kind), objectId: googleObjectId(env.google.issuerId, payload.pass.serial) };
  return toGoogleObject(model, ids, payload.pass.timezone);
}

/** Create/refresh the object on Google's side and return the customer-facing "Add to Google Wallet" URL. */
export async function publishGoogle(env: WalletEnv, admin: SupabaseClient, payload: PassPayload): Promise<{ url: string } | { error: string }> {
  if (!env.google) return { error: "GOOGLE_NOT_CONFIGURED" };
  const obj = googleObject(env, payload);
  const r = await upsertObject(env.google, String(obj.classId), obj);
  if (!r.ok) return { error: `GOOGLE_API_${r.status}${r.detail ? `: ${r.detail}` : ""}` };
  await admin.from("wallet_passes").update({ google_synced_at: new Date().toISOString() }).eq("id", payload.pass.id);
  return { url: await saveToWalletUrl(env.google, String(obj.id), [env.siteUrl]) };
}

/** Push a changed object to Google (already installed or at least created). Falls back to insert on 404. */
export async function refreshGoogle(env: WalletEnv, payload: PassPayload): Promise<GoogleResult> {
  if (!env.google) return { ok: false, status: 0, detail: "GOOGLE_NOT_CONFIGURED" };
  const obj = googleObject(env, payload);
  const r = await patchObject(env.google, obj);
  if (r.status !== 404) return r;
  const cls = await ensureClass(env.google, String(obj.classId));
  return cls.ok ? await upsertObject(env.google, String(obj.classId), obj) : cls;
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
