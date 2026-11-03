// Server-owned experiment lifecycle: create / start / stop / report. Clients cannot write experiments directly.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { DEFAULT_EVAL, evaluateExperiment, type ArmStats } from "../_shared/voice-studio/ab.ts";
import { buildArms, parseArms } from "../_shared/voice-studio/experiment.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const { data: allowed, error: pe } = await authClient.rpc("can_edit_call_scripts");
    if (pe) throw pe;
    if (allowed !== true) return json({ error: "You don't have permission to run voice experiments." }, 403);
    const { data: owner, error: oe } = await authClient.rpc("get_account_owner_id");
    if (oe || typeof owner !== "string") throw oe ?? new Error("owner_not_resolved");

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const id = String(body.id ?? "");

    if (body.action === "create") {
      const name = String(body.name ?? "").trim();
      if (name.length < 1 || name.length > 80) return json({ error: "Give the experiment a name (up to 80 characters)." }, 400);
      const arms = buildArms(Array.isArray(body.arms) ? (body.arms as { voiceKey: unknown; weight?: unknown }[]) : []);
      if (!arms) return json({ error: "Pick 2 or 3 different voices." }, 400);
      const minPerArm = Math.min(100000, Math.max(50, Math.round(Number(body.minPerArm ?? DEFAULT_EVAL.minPerArm)) || DEFAULT_EVAL.minPerArm));
      const { data, error } = await admin.from("voice_experiments")
        .insert({ user_id: owner, name, arms, min_per_arm: minPerArm }).select("id").single();
      if (error || !data) throw error ?? new Error("insert_failed");
      return json({ id: data.id });
    }

    const { data: exp } = await admin.from("voice_experiments").select("id,name,status,arms,min_per_arm")
      .eq("id", id).eq("user_id", owner).maybeSingle();
    if (!exp) return json({ error: "Experiment not found." }, 404);

    if (body.action === "start") {
      if (exp.status !== "draft") return json({ error: "Only a draft experiment can be started." }, 409);
      if (Deno.env.get("VOICE_STUDIO_RUNTIME") !== "on") {
        return json({ error: "Live voice routing isn't enabled yet.", code: "runtime_off" }, 409);
      }
      if (!parseArms(exp.arms)) return json({ error: "This experiment's voices are invalid." }, 409);
      const { error } = await admin.from("voice_experiments")
        .update({ status: "running", started_at: new Date().toISOString() }).eq("id", exp.id).eq("status", "draft");
      if (error) {
        if (error.code === "23505") return json({ error: "Another experiment is already running. Stop it first.", code: "already_running" }, 409);
        throw error;
      }
      return json({ ok: true });
    }

    if (body.action === "stop") {
      if (exp.status !== "running") return json({ error: "This experiment isn't running." }, 409);
      const reason = String(body.reason ?? "manual").slice(0, 120);
      await admin.from("voice_experiments")
        .update({ status: "stopped", stopped_at: new Date().toISOString(), stop_reason: reason }).eq("id", exp.id).eq("status", "running");
      return json({ ok: true });
    }

    if (body.action === "report") {
      const arms = parseArms(exp.arms);
      if (!arms) return json({ error: "This experiment's voices are invalid." }, 409);
      const { data: rows, error } = await authClient.rpc("voice_experiment_stats", { p_experiment: exp.id });
      if (error) throw error;
      const byArm = new Map<string, { n_calls: number; n_bookings: number; n_hangups: number }>();
      for (const r of (rows ?? []) as { arm: string; n_calls: number; n_bookings: number; n_hangups: number }[]) byArm.set(r.arm, r);
      const stats: ArmStats[] = arms.map((a) => {
        const r = byArm.get(a.key);
        return { key: a.key, calls: Number(r?.n_calls ?? 0), bookings: Number(r?.n_bookings ?? 0), hangups: Number(r?.n_hangups ?? 0) };
      });
      const decision = evaluateExperiment(stats, { ...DEFAULT_EVAL, minPerArm: exp.min_per_arm });
      let status = exp.status;
      if (decision.status === "stop_guardrail" && exp.status === "running") {
        await admin.from("voice_experiments")
          .update({ status: "stopped", stopped_at: new Date().toISOString(), stop_reason: `guardrail:${decision.arm}` })
          .eq("id", exp.id).eq("status", "running");
        status = "stopped";
      }
      return json({
        name: exp.name, status, decision, minPerArm: exp.min_per_arm,
        arms: arms.map((a, i) => ({
          key: a.key, voiceKey: a.voiceKey, ...stats[i],
          bookingRate: stats[i].calls ? stats[i].bookings / stats[i].calls : 0,
          hangupRate: stats[i].calls ? stats[i].hangups / stats[i].calls : 0,
        })),
      });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("voice-experiment error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
