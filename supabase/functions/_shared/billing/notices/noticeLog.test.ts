import { describe, expect, it } from "vitest";
import { sendNoticeOnce, type NoticeClient } from "./noticeLog";

/** In-memory model of the claim/complete/release SQL functions. */
function fakeDb(): NoticeClient & { rows: Map<string, { sent: boolean }> } {
  const rows = new Map<string, { sent: boolean }>();
  return {
    rows,
    async rpc(fn, a) {
      const k = `${a.p_user_id}|${a.p_kind}|${a.p_key}`;
      if (fn === "claim_billing_notice") { if (rows.has(k)) return { data: false, error: null }; rows.set(k, { sent: false }); return { data: true, error: null }; }
      if (fn === "complete_billing_notice") { const r = rows.get(k); if (r) r.sent = true; return { data: null, error: null }; }
      if (fn === "release_billing_notice") { if (rows.get(k)?.sent === false) rows.delete(k); return { data: null, error: null }; }
      return { data: null, error: { message: "unknown fn" } };
    },
  };
}

describe("sendNoticeOnce", () => {
  it("webhook replay sends exactly once", async () => {
    const db = fakeDb(); let sends = 0;
    const send = async () => { sends++; return { ok: true, channels: ["email"] }; };
    expect(await sendNoticeOnce(db, "u1", "payment_suspended", "payment:t1", send)).toBe("sent");
    expect(await sendNoticeOnce(db, "u1", "payment_suspended", "payment:t1", send)).toBe("duplicate");
    expect(sends).toBe(1);
  });
  it("a different key (new failure streak) is a new notice", async () => {
    const db = fakeDb(); let sends = 0;
    const send = async () => { sends++; return { ok: true, channels: ["email"] }; };
    await sendNoticeOnce(db, "u1", "payment_suspended", "payment:t1", send);
    await sendNoticeOnce(db, "u1", "payment_suspended", "payment:t2", send);
    expect(sends).toBe(2);
  });
  it("failed or thrown sends release the claim so the next run retries", async () => {
    const db = fakeDb();
    expect(await sendNoticeOnce(db, "u1", "renewal_30d", "k", async () => ({ ok: false, channels: [], error: "resend down" }))).toBe("failed");
    expect(await sendNoticeOnce(db, "u1", "renewal_30d", "k", async () => { throw new Error("boom"); })).toBe("failed");
    expect(db.rows.size).toBe(0);
    expect(await sendNoticeOnce(db, "u1", "renewal_30d", "k", async () => ({ ok: true, channels: ["email"] }))).toBe("sent");
  });
  it("a claim error surfaces (never silently drops the notice)", async () => {
    const db: NoticeClient = { rpc: async () => ({ data: null, error: { message: "db down" } }) };
    await expect(sendNoticeOnce(db, "u1", "renewal_30d", "k", async () => ({ ok: true, channels: [] }))).rejects.toThrow("db down");
  });
});
