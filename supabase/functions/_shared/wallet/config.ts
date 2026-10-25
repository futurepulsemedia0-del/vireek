// supabase/functions/_shared/wallet/config.ts
// Reads Wallet secrets from the environment. Each platform is optional: a missing one is reported, never guessed.

import type { ApplePassCredentials } from "./applePkpass.ts";
import type { GoogleCreds } from "./googleWallet.ts";
import type { AppleConfig } from "./passModel.ts";

export interface WalletEnv {
  apple: (ApplePassCredentials & AppleConfig) | null;
  google: GoogleCreds | null;
  /** Customer-facing link base (SMS / portal): the branded landing page `${SITE_URL}/w/<token>`. No trailing slash. */
  linkBase: string;
  siteUrl: string;
  /** Base of the wallet-pass edge function (what Apple calls back). */
  functionBase: string;
}

function parseServiceAccount(raw: string | undefined): { client_email: string; private_key: string } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j?.client_email && j?.private_key ? j : null;
  } catch {
    return null;
  }
}

export function readWalletEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): WalletEnv {
  const siteUrl = (get("SITE_URL") ?? "https://vireek.com").replace(/\/+$/, "");
  const functionBase = `${(get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/wallet-pass`;
  const linkBase = (get("WALLET_LINK_BASE") ?? `${siteUrl}/w`).replace(/\/+$/, "");

  const cert = get("APPLE_PASS_CERT_PEM");
  const key = get("APPLE_PASS_KEY_PEM");
  const wwdr = get("APPLE_WWDR_PEM");
  const passType = get("APPLE_PASS_TYPE_ID");
  const team = get("APPLE_TEAM_ID");
  const apple = cert && key && wwdr && passType && team
    ? { certPem: cert, keyPem: key, wwdrPem: wwdr, passTypeIdentifier: passType, teamIdentifier: team, webServiceURL: functionBase }
    : null;

  const sa = parseServiceAccount(get("GOOGLE_WALLET_SA_JSON"));
  const issuer = get("GOOGLE_WALLET_ISSUER_ID");
  const google = sa && issuer ? { issuerId: issuer, clientEmail: sa.client_email, privateKeyPem: sa.private_key } : null;

  return { apple, google, linkBase, siteUrl, functionBase };
}

export function decodeB64Env(v: string | undefined): Uint8Array | null {
  if (!v) return null;
  try {
    return Uint8Array.from(atob(v.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
