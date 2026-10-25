// supabase/functions/_shared/wallet/applePkpass.ts
//
// Builds a signed Apple Wallet .pkpass: pass.json + icons + manifest.json (SHA-1 per file) + detached
// PKCS#7 signature (SHA-256) made with the Pass Type ID certificate and chained to Apple's WWDR certificate.

import { strToU8, zipSync, zlibSync } from "npm:fflate@0.8.2";
import forge from "npm:node-forge@1.3.1";

export interface ApplePassCredentials {
  certPem: string; // Pass Type ID certificate (PEM)
  keyPem: string; // its private key (PEM, unencrypted)
  wwdrPem: string; // Apple WWDR intermediate (G4) (PEM)
}

/** Env secrets often arrive with literal "\n" sequences; make them real PEM. */
export const normalizePem = (v: string): string => v.replace(/\\n/g, "\n").trim() + "\n";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha1(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}

function binToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

export function signManifest(manifestJson: string, c: ApplePassCredentials, signingTime = new Date()): Uint8Array {
  const cert = forge.pki.certificateFromPem(normalizePem(c.certPem));
  const key = forge.pki.privateKeyFromPem(normalizePem(c.keyPem));
  const wwdr = forge.pki.certificateFromPem(normalizePem(c.wwdrPem));

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestJson, "utf8");
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: signingTime as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return binToBytes(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

// ---- minimal PNG encoder (solid-colour fallback icons; replace with real artwork via env) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Solid rounded-square icon in the brand colour. */
export function solidPng(size: number, colorHex: string): Uint8Array {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colorHex.slice(i, i + 2), 16));
  const radius = size * 0.22;
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (size - radius));
      const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (size - radius));
      const inside = Math.hypot(dx, dy) <= radius;
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}

export function defaultAssets(colorHex: string, overrides?: { icon?: Uint8Array | null; logo?: Uint8Array | null }): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {
    "icon.png": overrides?.icon ?? solidPng(29, colorHex),
    "icon@2x.png": overrides?.icon ?? solidPng(58, colorHex),
    "icon@3x.png": overrides?.icon ?? solidPng(87, colorHex),
  };
  if (overrides?.logo) { files["logo.png"] = overrides.logo; files["logo@2x.png"] = overrides.logo; }
  return files;
}

export async function buildPkpass(passJson: Record<string, unknown>, assets: Record<string, Uint8Array>, creds: ApplePassCredentials): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = { "pass.json": strToU8(JSON.stringify(passJson)), ...assets };
  const manifest: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) manifest[name] = await sha1(data);
  const manifestJson = JSON.stringify(manifest);
  const signature = signManifest(manifestJson, creds);
  return zipSync({ ...files, "manifest.json": strToU8(manifestJson), signature }, { level: 0 });
}
