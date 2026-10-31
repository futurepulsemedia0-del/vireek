// supabase/functions/bi-sftp-upload/index.ts
//
// Internal SFTP transport. The ONLY function that loads an SSH library, so an SSH/runtime problem can never
// affect S3 exports or the BI gateway. Called by bi-export-run and bi-admin, never by browsers.
//
//   X-Action: put    headers X-Target-Id, X-Remote-Path (URL-encoded, relative to the target's remote_path); body = file bytes
//   X-Action: test   header  X-Target-Id                                          -> { checks }
//   X-Action: probe  JSON body { host, port }                                     -> { fingerprint }   (SHA256:<base64>)
//
// Auth: X-Cron-Secret (same CRON_SECRET as the Data Platform). Host keys are pinned: a connection whose key
// does not match the saved fingerprint is refused. Files are written to a temp name, then renamed.
// Deploy: supabase functions deploy bi-sftp-upload --no-verify-jwt

// @ts-ignore: npm types are not resolved by the Edge bundler
import { Client } from "npm:ssh2@1.16.0";
import { adminClient, encryptionKey, isCron, json } from "../_shared/data-platform/http.ts";
import { openSecret } from "../_shared/data-platform/secrets.ts";
import { validateSftpConfig } from "../_shared/bi/export.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;

// deno-lint-ignore no-explicit-any
type Any = any;

const fingerprintOf = async (key: Uint8Array): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", key));
  return `SHA256:${btoa(String.fromCharCode(...d)).replace(/=+$/, "")}`;
};

/** Opens an SSH connection; `verify` decides whether the presented host key is acceptable. */
function connect(opts: Any, verify: (fp: string) => boolean): Promise<Any> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { conn.end(); reject(new Error("Connection timed out.")); }, 20_000);
    conn.on("ready", () => { clearTimeout(timer); resolve(conn); });
    conn.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    conn.connect({
      ...opts,
      readyTimeout: 20_000,
      hostHash: undefined,
      hostVerifier: (key: Uint8Array, cb: (ok: boolean) => void) => {
        fingerprintOf(key).then((fp) => cb(verify(fp))).catch(() => cb(false));
      },
    });
  });
}

const sftpOf = (conn: Any): Promise<Any> => new Promise((res, rej) => conn.sftp((e: Error | undefined, s: Any) => (e ? rej(e) : res(s))));
const call = <T = void>(fn: (cb: (e: Error | null | undefined, v?: T) => void) => void): Promise<T> => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v as T))));

async function mkdirp(sftp: Any, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "" : ".";
  for (const p of parts) {
    cur = cur === "" ? `/${p}` : `${cur}/${p}`;
    const exists = await call<unknown>((cb) => sftp.stat(cur, cb)).then(() => true, () => false);
    if (!exists) await call((cb) => sftp.mkdir(cur, cb));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!isCron(req)) return json({ error: "Forbidden" }, 403);
  const action = req.headers.get("X-Action");

  try {
    if (action === "probe") {
      const b = (await req.json()) as { host?: string; port?: number };
      let seen = "";
      const conn = await connect({ host: b.host, port: b.port ?? 22, username: "probe", password: "probe" }, (fp) => { seen = fp; return false; }).catch(() => null);
      conn?.end();
      return seen ? json({ fingerprint: seen }) : json({ error: "Could not read the server's host key. Check the host and port." }, 502);
    }

    const id = req.headers.get("X-Target-Id") ?? "";
    if (!UUID_RE.test(id)) return json({ error: "Invalid target." }, 400);
    const admin = adminClient();
    const { data: t } = await admin.from("bi_export_targets").select("id,user_id,kind,config").eq("id", id).eq("kind", "sftp").maybeSingle();
    if (!t) return json({ error: "Target not found." }, 404);
    const cfg = validateSftpConfig(t.config);
    if (!cfg.ok) return json({ error: "Target settings are invalid. Edit and save them again." }, 400);
    const { data: sec } = await admin.from("bi_secrets").select("secret_enc").eq("ref_id", id).maybeSingle();
    if (!sec?.secret_enc) return json({ error: "Stored credentials are missing. Edit the target and enter them again." }, 400);
    const creds = JSON.parse(await openSecret(sec.secret_enc as string, encryptionKey(), `bi_target:${id}`));

    let conn: Any;
    try {
      conn = await connect(
        { host: cfg.value.host, port: cfg.value.port, username: cfg.value.username, ...(creds.private_key ? { privateKey: creds.private_key, passphrase: creds.passphrase } : { password: creds.password }) },
        (fp) => fp === cfg.value.host_key_sha256,
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      return json({ error: /host key|verif/i.test(m) ? "The server's host key changed. Re-detect and confirm it before continuing." : /authentication|all configured/i.test(m) ? "The server rejected the username or credentials." : `Could not connect: ${m || "unknown error"}` }, 400);
    }
    try {
      const sftp = await sftpOf(conn);
      const root = cfg.value.remote_path;
      if (action === "test") {
        const probe = `${root}.vireek_connection_test`;
        if (root) await mkdirp(sftp, root.replace(/\/$/, ""));
        await call((cb) => sftp.writeFile(probe, new TextEncoder().encode("Vireek connection test\n"), cb));
        return json({ checks: [{ name: "Write access", ok: true, detail: `Wrote ${probe} on ${cfg.value.host}.` }] });
      }
      if (action !== "put") return json({ error: "Unknown action." }, 400);
      const rel = decodeURIComponent(req.headers.get("X-Remote-Path") ?? "");
      if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return json({ error: "Invalid path." }, 400);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_BYTES) return json({ error: "File too large." }, 413);
      const dest = `${root}${rel}`;
      await mkdirp(sftp, dest.slice(0, dest.lastIndexOf("/")));
      const tmp = `${dest}.part`;
      await call((cb) => sftp.writeFile(tmp, bytes, cb));
      await call((cb) => sftp.unlink(dest, () => cb(null)));
      await call((cb) => sftp.rename(tmp, dest, cb));
      return json({ ok: true });
    } finally {
      conn.end();
    }
  } catch (err) {
    console.error("[bi-sftp-upload]", err instanceof Error ? err.message : err);
    return json({ error: "SFTP transfer failed. Check the server and try again." }, 502);
  }
});
