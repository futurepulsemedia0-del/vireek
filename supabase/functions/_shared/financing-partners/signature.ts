const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header: string | null): { t: string; v1: string[] } | null {
  if (!header || header.length > 1024) return null;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v.toLowerCase());
  }
  if (!/^\d{9,12}$/.test(t) || v1.length === 0) return null;
  return { t, v1 };
}

export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): Promise<boolean> {
  if (!secret || secret.length < 16) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = (opts.nowMs ?? Date.now()) / 1000;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - Number(parsed.t)) > tolerance) return false;
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${rawBody}`);
  return parsed.v1.some((sig) => timingSafeEqualHex(expected, sig));
}

export async function signWebhook(rawBody: string, secret: string, nowMs: number = Date.now()): Promise<string> {
  const t = Math.floor(nowMs / 1000).toString();
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}
