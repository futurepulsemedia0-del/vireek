// supabase/functions/_shared/portal/recipe.ts
// Browser-automation framework core (DISABLED BY DEFAULT; infrastructure only). Declarative, versioned recipes run against an abstract
// BrowserDriver. Hard rules encoded here and covered by tests:
//   * no scripting step kinds - only the closed set below;
//   * selector missing -> DRIFT: stop, report, NEVER retry or improvise;
//   * MFA / CAPTCHA detected -> pause and hand to a human; there is no bypass code path;
//   * kill switch is re-checked before EVERY step (in-flight work stops);
//   * approval gate before any mutating step (default ON); dry-run never mutates;
//   * secrets are typed by the driver only; they are never put in events, results or screenshot names.
// No recipe for a real third-party site is included on purpose. [COUNSEL] authorisation + portal ToS must be confirmed per customer.

export type Value = { field: string } | { secret: "username" | "password" | "api_key" | "shared_secret" } | { literal: string };
export type Step =
  | { kind: "goto"; url: string }
  | { kind: "waitFor"; selector: string }
  | { kind: "fill"; selector: string; value: Value }
  | { kind: "click"; selector: string; mutates?: boolean }
  | { kind: "assertText"; selector: string; contains: string }
  | { kind: "screenshot"; name: string; mask?: string[] }
  | { kind: "approvalGate" }
  | { kind: "captureRef"; selector: string };
export interface Recipe { id: string; version: number; allowedHosts: string[]; steps: Step[] }

export const MAX_STEPS = 60;
const KINDS = new Set(["goto", "waitFor", "fill", "click", "assertText", "screenshot", "approvalGate", "captureRef"]);

export function validateRecipe(r: Recipe, opts: { allowInsecureLocalhost?: boolean } = {}): string[] {
  const errs: string[] = [];
  if (!r.id || !Number.isInteger(r.version) || r.version < 1) errs.push("recipe_identity_invalid");
  if (r.steps.length === 0 || r.steps.length > MAX_STEPS) errs.push("recipe_step_count_invalid");
  if (r.allowedHosts.length === 0) errs.push("allowed_hosts_required");
  let gated = false;
  r.steps.forEach((s, i) => {
    if (!KINDS.has((s as { kind: string }).kind)) { errs.push(`step_${i}_kind_not_allowed`); return; }
    if (s.kind === "goto") {
      try {
        const u = new URL(s.url);
        const local = opts.allowInsecureLocalhost && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
        if (u.protocol !== "https:" && !local) errs.push(`step_${i}_https_required`);
        if (!r.allowedHosts.includes(u.host)) errs.push(`step_${i}_host_not_allowed`);
      } catch { errs.push(`step_${i}_url_invalid`); }
    }
    if (s.kind === "approvalGate") gated = true;
    if (s.kind === "click" && s.mutates && !gated) errs.push(`step_${i}_mutating_click_needs_approval_gate_before`);
    if ("selector" in s && (s.selector.length === 0 || s.selector.length > 300)) errs.push(`step_${i}_selector_invalid`);
  });
  return errs;
}

export type ChallengeKind = "mfa" | "captcha";
export interface BrowserDriver {
  goto(url: string): Promise<void>;
  currentHost(): Promise<string>;
  exists(selector: string): Promise<boolean>;
  fill(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  text(selector: string): Promise<string>;
  screenshot(name: string, maskSelectors: string[]): Promise<string>; // returns storage path
  detectChallenge(): Promise<ChallengeKind | null>;
}
export interface RunContext {
  fields: Record<string, string>;
  secrets: Record<string, string>;
  dryRun: boolean;
  requireApproval: boolean;
  approved: boolean;
  isHalted: () => Promise<boolean>;
  onEvent: (e: { type: string; step: number; detail?: string }) => void;
}
export type RunStatus = "succeeded" | "dry_run_complete" | "paused_human" | "drift" | "halted" | "failed";
export interface RunResult { status: RunStatus; step: number; reason?: string; reference?: string; evidence: string[] }

const ALWAYS_MASK = ['input[type="password"]', "[data-sensitive]"];

export async function runRecipe(r: Recipe, d: BrowserDriver, ctx: RunContext, opts: { allowInsecureLocalhost?: boolean } = {}): Promise<RunResult> {
  const evidence: string[] = [];
  const bad = validateRecipe(r, opts);
  if (bad.length) return { status: "failed", step: -1, reason: bad[0], evidence };
  let reference: string | undefined;

  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    if (await ctx.isHalted()) { ctx.onEvent({ type: "halted", step: i }); return { status: "halted", step: i, reason: "kill_switch", evidence }; }
    const host = await d.currentHost();
    if (host && !r.allowedHosts.includes(host)) { ctx.onEvent({ type: "host_not_allowed", step: i }); return { status: "failed", step: i, reason: "host_not_allowed", evidence }; }
    const ch = await d.detectChallenge();
    if (ch) { ctx.onEvent({ type: "challenge_pause", step: i, detail: ch }); return { status: "paused_human", step: i, reason: ch, evidence }; }

    try {
      switch (s.kind) {
        case "goto": await d.goto(s.url); break;
        case "waitFor": if (!(await d.exists(s.selector))) return drift(i, ctx, evidence); break;
        case "assertText": {
          if (!(await d.exists(s.selector))) return drift(i, ctx, evidence);
          if (!(await d.text(s.selector)).includes(s.contains)) return drift(i, ctx, evidence, "assert_failed");
          break;
        }
        case "fill": {
          if (!(await d.exists(s.selector))) return drift(i, ctx, evidence);
          if (ctx.dryRun) break;                              // dry-run verifies selectors only
          const v = "field" in s.value ? ctx.fields[s.value.field] : "secret" in s.value ? ctx.secrets[s.value.secret] : s.value.literal;
          if (v === undefined) return { status: "failed", step: i, reason: "value_missing", evidence };
          await d.fill(s.selector, v);
          ctx.onEvent({ type: "fill", step: i, detail: "field" in s.value ? s.value.field : "secret" in s.value ? `secret:${s.value.secret}` : "literal" });
          break;
        }
        case "approvalGate":
          if (ctx.requireApproval && !ctx.approved && !ctx.dryRun) { ctx.onEvent({ type: "approval_pause", step: i }); return { status: "paused_human", step: i, reason: "approval_required", evidence }; }
          break;
        case "click": {
          if (!(await d.exists(s.selector))) return drift(i, ctx, evidence);
          if (ctx.dryRun && s.mutates) { ctx.onEvent({ type: "dry_run_skip_mutation", step: i }); break; }
          await d.click(s.selector);
          break;
        }
        case "captureRef": {
          if (!(await d.exists(s.selector))) return drift(i, ctx, evidence);
          reference = (await d.text(s.selector)).trim().slice(0, 200) || undefined;
          break;
        }
        case "screenshot": {
          const secretSelectors = ALWAYS_MASK;
          const p = await d.screenshot(s.name.replace(/[^\w-]/g, "_").slice(0, 60), [...secretSelectors, ...(s.mask ?? [])]);
          evidence.push(p);
          break;
        }
      }
    } catch {
      ctx.onEvent({ type: "step_error", step: i });
      return { status: "failed", step: i, reason: "driver_error", evidence };  // no retries here: the caller decides, with backoff
    }
  }
  return { status: ctx.dryRun ? "dry_run_complete" : "succeeded", step: r.steps.length, reference, evidence };
}

function drift(step: number, ctx: RunContext, evidence: string[], reason = "selector_missing"): RunResult {
  ctx.onEvent({ type: "drift_detected", step, detail: reason });
  return { status: "drift", step, reason, evidence };
}
