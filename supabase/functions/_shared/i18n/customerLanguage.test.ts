import { describe, expect, it, vi } from "vitest";
import {
  buildVoiceFirstMessage,
  buildVoiceLanguageContext,
  findCustomerLanguage,
  recordLanguageFromCall,
  recordLanguageFromMessage,
  resolveCustomerLanguage,
  resolveVoiceLanguage,
  storeDetectedLanguage,
} from "./customerLanguage";

type RpcResult = { data: unknown; error: { message: string } | null };

/** Minimal fake of the bits of SupabaseClient these helpers touch. */
function fakeAdmin(opts: { rpc?: Record<string, RpcResult | (() => RpcResult)>; company?: string | null; updateError?: string } = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const updates: { table: string; patch: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const r = opts.rpc?.[fn];
      if (!r) return { data: null, error: null };
      return typeof r === "function" ? r() : r;
    }),
    from: vi.fn((table: string) => {
      const filters: [string, unknown][] = [];
      let patch: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          // terminal for update chains: resolve when awaited
          return Object.assign(Promise.resolve({ error: opts.updateError ? { message: opts.updateError } : null }), {
            eq: (c: string, v: unknown) => {
              filters.push([c, v]);
              updates.push({ table, patch, filters });
              return Promise.resolve({ error: opts.updateError ? { message: opts.updateError } : null });
            },
            maybeSingle: async () => ({ data: { company_name: opts.company ?? null }, error: null }),
          });
        },
      };
      return chain;
    }),
  };
  return { admin: admin as never, rpcCalls, updates };
}

describe("findCustomerLanguage / resolveCustomerLanguage", () => {
  it("returns null without any identifier (and does not hit the database)", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    expect(await findCustomerLanguage(admin, "u1", {})).toBeNull();
    expect(rpcCalls).toHaveLength(0);
  });

  it("passes identifiers through and normalizes the answer", async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpc: { find_customer_language: { data: [{ language: "FA-ir", source: "staff" }], error: null } } });
    const found = await findCustomerLanguage(admin, "u1", { phone: "+15551234567" });
    expect(found).toEqual({ language: "fa", source: "staff" });
    expect(rpcCalls[0].args).toMatchObject({ p_user_id: "u1", p_phone: "+15551234567", p_customer_id: null, p_email: null });
  });

  it("ignores unsupported values and unknown sources", async () => {
    const bad = fakeAdmin({ rpc: { find_customer_language: { data: [{ language: "pt", source: "staff" }], error: null } } });
    expect(await findCustomerLanguage(bad.admin, "u1", { phone: "1" })).toBeNull();
    const odd = fakeAdmin({ rpc: { find_customer_language: { data: [{ language: "es", source: "???" }], error: null } } });
    expect(await findCustomerLanguage(odd.admin, "u1", { phone: "1" })).toEqual({ language: "es", source: null });
  });

  it("never throws: RPC error and thrown exception both fall back", async () => {
    const err = fakeAdmin({ rpc: { find_customer_language: { data: null, error: { message: "boom" } } } });
    expect(await resolveCustomerLanguage(err.admin, "u1", { phone: "1" })).toBe("en");
    const thrower = fakeAdmin({ rpc: { find_customer_language: () => { throw new Error("network"); } } });
    expect(await resolveCustomerLanguage(thrower.admin, "u1", { phone: "1" }, "de")).toBe("de");
  });

  it("uses the stored language when known", async () => {
    const { admin } = fakeAdmin({ rpc: { find_customer_language: { data: [{ language: "ja", source: "customer" }], error: null } } });
    expect(await resolveCustomerLanguage(admin, "u1", { email: "a@b.co" })).toBe("ja");
  });
});

describe("storeDetectedLanguage / recordLanguageFromMessage", () => {
  it("skips when there is neither phone nor email", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    expect(await storeDetectedLanguage(admin, "u1", {}, "es", 0.9)).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns the changed-row count from SQL", async () => {
    const { admin } = fakeAdmin({ rpc: { record_detected_customer_language: { data: 2, error: null } } });
    expect(await storeDetectedLanguage(admin, "u1", { phone: "1" }, "es", 0.9)).toBe(2);
  });

  it("stores a confident detection from an inbound message", async () => {
    const { admin, rpcCalls } = fakeAdmin({ rpc: { record_detected_customer_language: { data: 1, error: null } } });
    const d = await recordLanguageFromMessage(admin, "u1", { phone: "+1555" }, "Hola, necesito que arreglen mi aire acondicionado por favor");
    expect(d.language).toBe("es");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({ p_language: "es", p_phone: "+1555" });
  });

  it("does not store short / ambiguous messages", async () => {
    const { admin, rpcCalls } = fakeAdmin();
    await recordLanguageFromMessage(admin, "u1", { phone: "+1555" }, "STOP");
    await recordLanguageFromMessage(admin, "u1", { phone: "+1555" }, "ok thanks");
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("recordLanguageFromCall", () => {
  const transcript = "AI: Hello, how can I help?\nUser: Bonjour, j'ai besoin d'un plombier pour réparer une fuite d'eau dans ma maison";

  it("stamps the call row and remembers the language on the customer", async () => {
    const { admin, rpcCalls, updates } = fakeAdmin({ rpc: { record_detected_customer_language: { data: 1, error: null } } });
    const d = await recordLanguageFromCall(admin, { userId: "u1", vapiCallId: "call_1", callerNumber: "+15550001111", transcript });
    expect(d.language).toBe("fr");
    expect(updates[0]).toMatchObject({ table: "calls", patch: { detected_language_code: "fr" } });
    expect(updates[0].filters).toEqual([["user_id", "u1"], ["vapi_call_id", "call_1"]]);
    expect(rpcCalls[0]).toMatchObject({ fn: "record_detected_customer_language", args: { p_language: "fr", p_phone: "+15550001111" } });
  });

  it("does nothing for an unsupported or unclear language", async () => {
    const { admin, rpcCalls, updates } = fakeAdmin();
    const d = await recordLanguageFromCall(admin, { userId: "u1", vapiCallId: "c", callerNumber: "+1", transcript: "AI: hi\nUser: Olá, preciso de um técnico para consertar o ar condicionado da minha casa" });
    expect(d.language).toBeNull();
    expect(rpcCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("works without a caller number (stamps the call only) and without transcript (no-op)", async () => {
    const a = fakeAdmin();
    await recordLanguageFromCall(a.admin, { userId: "u1", vapiCallId: "c", transcript });
    expect(a.rpcCalls).toHaveLength(0);
    expect(a.updates).toHaveLength(1);
    const b = fakeAdmin();
    expect((await recordLanguageFromCall(b.admin, { userId: "u1", callerNumber: "+1", transcript: null })).language).toBeNull();
  });

  it("never throws even if the database does", async () => {
    const { admin } = fakeAdmin({ updateError: "db down", rpc: { record_detected_customer_language: () => { throw new Error("x"); } } });
    await expect(recordLanguageFromCall(admin, { userId: "u1", vapiCallId: "c", callerNumber: "+1", transcript })).resolves.toBeDefined();
  });
});

describe("voice agent context", () => {
  it("unknown language: starts in English, adapts, lists supported languages", () => {
    const s = buildVoiceLanguageContext(null);
    expect(s).toMatch(/not known yet/i);
    expect(s).toMatch(/Spanish/);
    expect(s).toMatch(/Persian/);
    expect(s).toMatch(/emergency/i);
  });

  it("known non-English language: speak it from the first sentence, but follow the caller", () => {
    const s = buildVoiceLanguageContext("es");
    expect(s).toMatch(/Spanish \(es\)/);
    expect(s).toMatch(/first sentence/);
    expect(s).toMatch(/switch to theirs/);
  });

  it("known English: still adapts if the caller switches", () => {
    expect(buildVoiceLanguageContext("en")).toMatch(/switch/);
  });

  it("first message is only built for non-English with a business name", () => {
    expect(buildVoiceFirstMessage(null, "Acme", "Sarah")).toBeNull();
    expect(buildVoiceFirstMessage("en", "Acme", "Sarah")).toBeNull();
    expect(buildVoiceFirstMessage("es", "", "Sarah")).toBeNull();
    expect(buildVoiceFirstMessage("es", "Acme Plomería", "Sarah")).toBe("Hola, gracias por llamar a Acme Plomería. Habla Sarah. ¿En qué puedo ayudarle hoy?");
    expect(buildVoiceFirstMessage("fr", "Acme", null)).toContain("votre assistant virtuel");
  });

  it("resolveVoiceLanguage bundles lookup + greeting and degrades gracefully", async () => {
    const known = fakeAdmin({ company: "Acme Heating", rpc: { find_customer_language: { data: [{ language: "de", source: "staff" }], error: null } } });
    const r = await resolveVoiceLanguage(known.admin, "u1", "+1555", "Sarah");
    expect(r.language).toBe("de");
    expect(r.firstMessage).toContain("Acme Heating");
    expect(r.context).toMatch(/German/);

    const unknown = fakeAdmin();
    const u = await resolveVoiceLanguage(unknown.admin, "u1", "+1555", "Sarah");
    expect(u.language).toBeNull();
    expect(u.firstMessage).toBeNull();

    const noNumber = await resolveVoiceLanguage(unknown.admin, "u1", null, null);
    expect(noNumber.language).toBeNull();
  });
});
