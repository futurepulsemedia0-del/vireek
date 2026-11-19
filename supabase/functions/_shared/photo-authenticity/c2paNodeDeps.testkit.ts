// TEST-ONLY: wires the real @contentauth/c2pa-wasm into C2paDeps under Node (production wiring is Deno, in functions/photo-provenance/index.ts).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync, WasmReader } from "@contentauth/c2pa-wasm";
import type { C2paDeps } from "./c2pa.ts";

let ready = false;
export function nodeC2paDeps(trustAnchorsPem?: string): C2paDeps {
  if (!ready) {
    const require = createRequire(import.meta.url);
    initSync({ module: readFileSync(require.resolve("@contentauth/c2pa-wasm/c2pa.wasm")) });
    ready = true;
  }
  return {
    trustAnchorsPem,
    async readManifestStore(mime, bytes, contextJson) {
      const reader = await WasmReader.fromBytes(mime, bytes, contextJson);
      try { return reader.manifestStore(); } finally { reader.free(); }
    },
  };
}
