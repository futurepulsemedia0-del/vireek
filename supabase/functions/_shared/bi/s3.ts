// supabase/functions/_shared/bi/s3.ts
//
// Minimal, dependency-free S3 client: AWS Signature V4 + PutObject. Works with Amazon S3 and any
// S3-compatible store (Cloudflare R2, Backblaze B2, MinIO, Wasabi, DigitalOcean Spaces, GCS interop).
//
// Least privilege: Vireek only ever needs  s3:PutObject  on  arn:aws:s3:::<bucket>/<prefix>*
// (no read, list or delete permission is used).
//
// Pure apart from fetch: WebCrypto only.

import { isPublicHost, type Validation } from "../data-platform/warehouse.ts";
import { sha256Hex } from "./access.ts";

export interface S3Config { kind: "s3"; bucket: string; region: string; endpoint: string | null; prefix: string; sse: boolean }
export interface S3Credentials { access_key_id: string; secret_access_key: string; session_token?: string }

export class StorageError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
  }
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,32}$/;
const PREFIX_RE = /^[A-Za-z0-9._\-=/]*$/;

/** "exports/vireek" -> "exports/vireek/"; "" stays ""; rejects "..", leading "/", odd characters. */
export function normalizePrefix(raw: unknown): string | null {
  const p = typeof raw === "string" ? raw.trim().replace(/^\/+/, "") : "";
  if (p.length > 200 || !PREFIX_RE.test(p) || p.split("/").includes("..")) return null;
  const clean = p.replace(/\/{2,}/g, "/");
  return clean && !clean.endsWith("/") ? `${clean}/` : clean;
}

export function validateS3Config(raw: unknown): Validation<S3Config> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const bucket = typeof r.bucket === "string" ? r.bucket.trim() : "";
  if (!BUCKET_RE.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) errors.bucket = "Enter the bucket name only (3–63 lowercase letters, digits, dots or hyphens).";
  const region = typeof r.region === "string" ? r.region.trim().toLowerCase() : "";
  if (!REGION_RE.test(region)) errors.region = "Enter the region, e.g. us-east-1 (use “auto” for Cloudflare R2).";
  let endpoint: string | null = null;
  const epRaw = typeof r.endpoint === "string" ? r.endpoint.trim() : "";
  if (epRaw) {
    try {
      const u = new URL(epRaw);
      if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || !isPublicHost(u.hostname)) throw new Error("bad");
      endpoint = u.origin;
    } catch {
      errors.endpoint = "Use a public https:// address with no path, e.g. https://<account>.r2.cloudflarestorage.com";
    }
  }
  const prefix = normalizePrefix(r.prefix);
  if (prefix === null) errors.prefix = "Use letters, digits and . _ - = / only (no “..”).";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { kind: "s3", bucket, region, endpoint, prefix: prefix as string, sse: r.sse === true } };
}

export function validateS3Credentials(raw: unknown): Validation<S3Credentials> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const id = typeof r.access_key_id === "string" ? r.access_key_id.trim() : "";
  const secret = typeof r.secret_access_key === "string" ? r.secret_access_key.trim() : "";
  const token = typeof r.session_token === "string" ? r.session_token.trim() : "";
  if (!/^[A-Za-z0-9]{16,128}$/.test(id)) errors.access_key_id = "Paste the access key id.";
  if (secret.length < 16 || secret.length > 256 || /\s/.test(secret)) errors.secret_access_key = "Paste the secret access key (no spaces).";
  if (token.length > 4096) errors.session_token = "Session token is too long.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { access_key_id: id, secret_access_key: secret, ...(token ? { session_token: token } : {}) } };
}

// ---------------- Signature V4 ----------------

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** RFC 3986 encoding as SigV4 requires (also encodes ! ' ( ) *). */
export const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key: string): string => key.split("/").map(rfc3986).join("/");

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export interface SignInput {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  body?: Uint8Array;
  region: string;
  creds: S3Credentials;
  now?: Date;
}

/** Returns the request headers to send (without Host, which fetch sets itself). */
export async function signRequest(i: SignInput): Promise<Record<string, string>> {
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(i.body ?? new Uint8Array());

  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers ?? {})) h[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  h["x-amz-date"] = amzDate;
  h["x-amz-content-sha256"] = payloadHash;
  if (i.creds.session_token) h["x-amz-security-token"] = i.creds.session_token;
  const signedNames = [...Object.keys(h), "host"].sort();
  const all: Record<string, string> = { ...h, host: i.url.host };
  const canonicalHeaders = signedNames.map((n) => `${n}:${all[n]}\n`).join("");
  const query = [...i.url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [i.method, i.url.pathname || "/", query, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${i.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  const kDate = await hmac(`AWS4${i.creds.secret_access_key}`, dateStamp);
  const kRegion = await hmac(kDate, i.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, toSign));
  h.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.access_key_id}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  return h;
}

// ---------------- requests ----------------

export function objectUrl(cfg: Pick<S3Config, "bucket" | "region" | "endpoint">, key: string): URL {
  const k = encodeKey(key);
  if (cfg.endpoint) return new URL(`${cfg.endpoint}/${cfg.bucket}/${k}`);
  if (!cfg.bucket.includes(".")) return new URL(`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${k}`);
  return new URL(`https://s3.${cfg.region}.amazonaws.com/${cfg.bucket}/${k}`);
}

function describeFailure(status: number, headers: Headers, body: string, cfg: S3Config): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  const region = headers.get("x-amz-bucket-region");
  if (code === "SignatureDoesNotMatch") return "The storage service rejected the signature. Check the secret access key (no extra spaces) and the region.";
  if (code === "InvalidAccessKeyId") return "The access key id does not exist for this provider.";
  if (code === "AccessDenied" || code === "AllAccessDisabled") return `Access denied. The key needs permission to write objects (s3:PutObject) under ${cfg.bucket}/${cfg.prefix}.`;
  if (code === "NoSuchBucket") return `Bucket “${cfg.bucket}” was not found. Check its name${cfg.endpoint ? " and the endpoint" : " and region"}.`;
  if (code === "ExpiredToken" || code === "InvalidToken") return "The session token is invalid or has expired.";
  if (region && region !== cfg.region) return `The bucket lives in ${region}, not ${cfg.region}. Change the region and try again.`;
  if (code === "PermanentRedirect" || code === "AuthorizationHeaderMalformed") return "The bucket region or endpoint does not match. Check both and try again.";
  return `Storage error ${status}${code ? ` (${code})` : ""}.`;
}

export async function putObject(cfg: S3Config, creds: S3Credentials, key: string, body: Uint8Array, contentType: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = objectUrl(cfg, key);
  const headers = await signRequest({
    method: "PUT",
    url,
    region: cfg.region,
    creds,
    body,
    headers: { "content-type": contentType, ...(cfg.sse ? { "x-amz-server-side-encryption": "AES256" } : {}) },
  });
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "PUT", headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    // 503: a network fault is worth retrying (classifyFailure treats >= 500 as retryable).
    throw new StorageError(`Could not reach the storage service (${e instanceof Error ? e.message : "network error"}).`, 503);
  }
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  throw new StorageError(describeFailure(res.status, res.headers, await res.text().catch(() => ""), cfg), res.status);
}
