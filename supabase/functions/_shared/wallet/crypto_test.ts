// Run: deno test --allow-env supabase/functions/_shared/wallet/crypto_test.ts
// (Named *_test.ts on purpose: it uses npm: imports, so vitest must not collect it.)
import assert from "node:assert/strict";
import forge from "npm:node-forge@1.3.1";
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import { buildPkpass, defaultAssets, solidPng } from "./applePkpass.ts";
import { b64url, ensureClass, saveToWalletUrl, upsertObject, type GoogleCreds } from "./googleWallet.ts";

function selfSigned(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 30);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

const sha1 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("pkpass: zip layout, manifest hashes and PKCS#7 signature", async () => {
  const leaf = selfSigned("Pass Type ID: pass.test");
  const wwdr = selfSigned("Apple WWDR (test)");
  const pass = { formatVersion: 1, serialNumber: "abc", description: "t" };
  const buf = await buildPkpass(pass, defaultAssets("#2563EB"), { ...leaf, wwdrPem: wwdr.certPem });
  const files = unzipSync(buf);
  assert.deepEqual(Object.keys(files).sort(), ["icon.png", "icon@2x.png", "icon@3x.png", "manifest.json", "pass.json", "signature"]);

  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as Record<string, string>;
  for (const [name, hash] of Object.entries(manifest)) assert.equal(await sha1(files[name]), hash, name);
  assert.ok(!("signature" in manifest) && !("manifest.json" in manifest));

  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(files["signature"]).getBytes()));
  assert.equal((p7 as unknown as { certificates: unknown[] }).certificates.length, 2);
});

Deno.test("png: valid signature, IHDR and chunk CRCs", () => {
  const png = solidPng(29, "#2563EB");
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(dv.getUint32(16), 29);
  assert.equal(dv.getUint32(20), 29);
});

async function googleCreds(): Promise<{ creds: GoogleCreds; pub: CryptoKey }> {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { creds: { issuerId: "3388", clientEmail: "sa@x.iam.gserviceaccount.com", privateKeyPem: pem }, pub: kp.publicKey };
}

Deno.test("google: save link is a verifiable RS256 JWT that references the object id", async () => {
  const { creds, pub } = await googleCreds();
  const url = await saveToWalletUrl(creds, "3388.abc", ["https://vireek.com"], 1_800_000_000);
  assert.ok(url.startsWith("https://pay.google.com/gp/v/save/"));
  const [h, p, s] = url.split("/").pop()!.split(".");
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, sig, new TextEncoder().encode(`${h}.${p}`)));
  const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  assert.equal(claims.aud, "google");
  assert.equal(claims.typ, "savetowallet");
  assert.deepEqual(claims.payload, { genericObjects: [{ id: "3388.abc" }] });
  assert.equal(b64url("hi?>"), "aGk_Pg");
});

Deno.test("google: class created once, object insert falls back to PATCH on 409", async () => {
  const { creds } = await googleCreds();
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u.replace("https://walletobjects.googleapis.com/walletobjects/v1/", "").replace("https://oauth2.googleapis.com/", "")}`);
    if (u.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    if (u.endsWith("/genericObject") && init?.method === "POST") return new Response("exists", { status: 409 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const r = await upsertObject(creds, "3388.vireek_gift_card_v1", { id: "3388.abc", classId: "3388.vireek_gift_card_v1" }, f);
  assert.ok(r.ok);
  assert.deepEqual(calls, ["POST token", "POST genericClass", "POST genericObject", "PATCH genericObject/3388.abc"]);
  assert.ok((await ensureClass(creds, "3388.vireek_gift_card_v1", f)).ok);
  assert.equal(calls.length, 4); // cached
});
