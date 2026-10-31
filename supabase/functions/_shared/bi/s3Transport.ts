// supabase/functions/_shared/bi/s3Transport.ts
import type { Check } from "../data-platform/adapters/types.ts";
import type { Transport } from "./export.ts";
import { putObject, type S3Config, type S3Credentials } from "./s3.ts";

export function createS3Transport(cfg: S3Config, creds: S3Credentials, fetchImpl: typeof fetch = fetch): Transport {
  return {
    put: (path, data, contentType) => putObject(cfg, creds, path, data, contentType, fetchImpl),
    async test(): Promise<Check[]> {
      const key = `${cfg.prefix}_vireek_connection_test.txt`;
      try {
        await putObject(cfg, creds, key, new TextEncoder().encode(`Vireek connection test ${new Date().toISOString()}\n`), "text/plain", fetchImpl);
        return [{ name: "Write access", ok: true, detail: `Wrote ${key} to ${cfg.bucket}.` }];
      } catch (e) {
        return [{ name: "Write access", ok: false, detail: e instanceof Error ? e.message : "Could not write to the bucket." }];
      }
    },
  };
}
