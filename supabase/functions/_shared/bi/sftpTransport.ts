// supabase/functions/_shared/bi/sftpTransport.ts
// Transport that hands files to the isolated `bi-sftp-upload` function (the only place that loads an SSH library),
// so an SSH problem can never break S3 exports or the BI gateway.

import type { Check } from "../data-platform/adapters/types.ts";
import type { Transport } from "./export.ts";

export class SftpError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
  }
}

export function createSftpTransport(o: { baseUrl: string; cronSecret: string; targetId: string; fetchImpl?: typeof fetch }): Transport {
  const f = o.fetchImpl ?? fetch;
  const call = async (action: "put" | "test", path: string, body?: Uint8Array) => {
    const res = await f(`${o.baseUrl.replace(/\/$/, "")}/functions/v1/bi-sftp-upload`, {
      method: "POST",
      headers: { "X-Cron-Secret": o.cronSecret, "X-Action": action, "X-Target-Id": o.targetId, "X-Remote-Path": encodeURIComponent(path), "Content-Type": "application/octet-stream" },
      body: body ?? new Uint8Array(),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string; checks?: Check[] };
    if (!res.ok) throw new SftpError(payload.error ?? `SFTP service error ${res.status}.`, res.status === 401 || res.status === 403 ? 403 : res.status >= 500 ? 503 : 400);
    return payload;
  };
  return {
    async put(path, data) { await call("put", path, data); },
    async test() { return (await call("test", "")).checks ?? []; },
  };
}
