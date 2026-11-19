import { describe, expect, it } from "vitest";
import { handleFmPortalEmail, hasFmTag } from "./emailEntry.ts";

interface Opts { owner?: boolean; member?: boolean; store?: Record<string, unknown>; uploadError?: boolean }
function fakeAdmin(o: Opts) {
  const calls: { rpc: [string, any][]; uploads: string[] } = { rpc: [], uploads: [] };
  const q = (hit: boolean) => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: hit ? { id: "x" } : null }) }; return c; };
  const admin: any = {
    from: (t: string) => q(t === "profiles" ? !!o.owner : !!o.member),
    rpc: async (name: string, args: any) => { calls.rpc.push([name, args]); return name === "wog_ingest_store" ? { data: o.store ?? { ok: true, duplicate: false, id: args.p.id }, error: null } : { data: null, error: null }; },
    storage: { from: () => ({ upload: async (path: string) => { calls.uploads.push(path); return { error: o.uploadError ? new Error("boom") : null }; } }) },
  };
  return { admin, calls };
}
const mail = (over: Record<string, unknown> = {}) => ({
  userId: "11111111-1111-1111-1111-111111111111", toLocalPart: "abc123+fm", from: "Owner <owner@acme.test>", subject: "Fwd: WO 555\r\nBcc: x@y.z",
  text: "Work Order: 555\nNTE: $100\nDate Received: 9/2/2026 7:15 AM", html: null, ...over,
}) as any;

describe("hasFmTag", () => {
  it("accepts only the +fm tag (case-insensitive)", () => {
    expect(hasFmTag("abc+fm")).toBe(true);
    expect(hasFmTag("abc+FM")).toBe(true);
    for (const x of ["abc", "abc+chubb", "abc+fm2", "abc+fm+x", "+"]) expect(hasFmTag(x)).toBe(false);
  });
});

describe("handleFmPortalEmail", () => {
  it("ignores mail without the +fm tag", async () => {
    const { admin, calls } = fakeAdmin({ owner: true });
    expect(await handleFmPortalEmail(admin, mail({ toLocalPart: "abc123" }))).toEqual({ handled: false });
    expect(calls.rpc).toHaveLength(0);
  });
  it("does not handle an unknown sender", async () => {
    const { admin, calls } = fakeAdmin({});
    expect(await handleFmPortalEmail(admin, mail())).toEqual({ handled: false });
    expect(calls.rpc).toHaveLength(0);
  });
  it("rejects a malformed / multi-recipient From", async () => {
    const { admin } = fakeAdmin({ owner: true });
    expect(await handleFmPortalEmail(admin, mail({ from: "a@b.com, c@d.com" }))).toEqual({ handled: false });
  });
  it("stores a sanitized item and the original for a known sender (owner or team member)", async () => {
    for (const who of [{ owner: true }, { member: true }]) {
      const { admin, calls } = fakeAdmin(who);
      expect(await handleFmPortalEmail(admin, mail({ html: "<script>x</script>" }))).toEqual({ handled: true });
      const p = calls.rpc[0][1].p;
      expect(calls.rpc[0][0]).toBe("wog_ingest_store");
      expect(p.channel).toBe("email");
      expect(p.sender).toBe("owner@acme.test");
      expect(p.subject).toBe("Fwd: WO 555 Bcc: x@y.z"); // header injection flattened
      expect(p.status).toBe("ready");
      expect(calls.uploads[0]).toBe(`11111111-1111-1111-1111-111111111111/${p.id}.json`);
    }
  });
  it("is idempotent: a duplicate is handled without a second upload", async () => {
    const { admin, calls } = fakeAdmin({ owner: true, store: { ok: true, duplicate: true, id: "z" } });
    expect(await handleFmPortalEmail(admin, mail())).toEqual({ handled: true });
    expect(calls.uploads).toHaveLength(0);
  });
  it("falls through to the normal inbox on rate limit, empty body or storage failure (and discards the row)", async () => {
    expect(await handleFmPortalEmail(fakeAdmin({ owner: true, store: { ok: false, reason: "rate_limited" } }).admin, mail())).toEqual({ handled: false });
    expect(await handleFmPortalEmail(fakeAdmin({ owner: true }).admin, mail({ text: "  ", html: "<b></b>" }))).toEqual({ handled: false });
    const { admin, calls } = fakeAdmin({ owner: true, uploadError: true });
    expect(await handleFmPortalEmail(admin, mail())).toEqual({ handled: false });
    expect(calls.rpc.map((c) => c[0])).toEqual(["wog_ingest_store", "wog_ingest_discard"]);
  });
});
