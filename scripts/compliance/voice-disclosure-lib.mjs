// Voice-flow AI-disclosure guard (pure; no I/O except via the injected file list).
// DRAFT - NOT LEGAL ADVICE. See docs/compliance/state-ai-laws.md. It proves WIRING in source, never what a live call said.
//
// Rules enforced by evaluate():
//   R1  every file that places or answers a call (SIGNATURES) must appear in the registry          (new flow = fail)
//   R2  every registry path must still exist AND still match a signature                           (stale entry = fail)
//   R3  aiSpeaksToThirdParty=true needs disclosure.mode in COUNTED_MODES and EVERY evidence regex must match its file
//   R4  aiSpeaksToThirdParty=false needs a non-empty `reason`
//   R5  a flow with no disclosure that speaks AI to a third party is a "gap": allowed ONLY when listed in the baseline
//       (legacy debt, like scripts/migrations). A baseline entry whose flow is now compliant or gone = fail (shrink only).

export const SIGNATURES = {
  vapiCreate: /https:\/\/api\.vapi\.ai\/call["'`](?!\/)/,
  twilioCalls: /Calls\.json/,
  twimlSay: /<Say[\s>]/,
  startCall: /\bstartCall\s*\(/,
  assistantRequest: /async function handleAssistantRequest\(/,
};
export const COUNTED_MODES = ["webhook_plan", "variable_injection", "explicit_first_message", "fixed_script"];
export const SCAN_ROOT = "supabase/functions";

/** files: [{ path: "supabase/functions/x/index.ts", text }]  -> paths that place/answer calls */
export function discover(files) {
  const out = [];
  for (const f of files) {
    if (/\.test\.[cm]?[jt]s$/.test(f.path)) continue;
    if (Object.values(SIGNATURES).some((re) => re.test(f.text))) out.push(f.path);
  }
  return out.sort();
}

export function evaluate({ files, registry, baseline }) {
  const errors = [];
  const warnings = [];
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const found = new Set(discover(files));
  const entries = new Map();
  for (const e of registry.flows ?? []) {
    if (entries.has(e.path)) errors.push(`R1 duplicate registry entry: ${e.path}`);
    entries.set(e.path, e);
  }
  const gaps = new Set(baseline.knownGaps ?? []);

  for (const p of found) if (!entries.has(p)) errors.push(`R1 call flow not in registry (classify it and prove disclosure): ${p}`);
  for (const p of entries.keys()) {
    if (!byPath.has(p)) errors.push(`R2 registry entry points to a missing file: ${p}`);
    else if (!found.has(p)) errors.push(`R2 registry entry no longer matches any call signature (remove or fix): ${p}`);
  }

  const gapNow = new Set();
  for (const [p, e] of entries) {
    if (!byPath.has(p)) continue;
    if (typeof e.aiSpeaksToThirdParty !== "boolean") { errors.push(`R3 ${p}: aiSpeaksToThirdParty must be true or false`); continue; }
    if (!e.aiSpeaksToThirdParty) {
      if (!String(e.reason ?? "").trim()) errors.push(`R4 ${p}: aiSpeaksToThirdParty=false needs a reason`);
      continue;
    }
    const d = e.disclosure ?? {};
    let ok = COUNTED_MODES.includes(d.mode);
    if (!ok) { gapNow.add(p); continue; }
    const ev = Array.isArray(d.evidence) ? d.evidence : [];
    if (ev.length === 0) { errors.push(`R3 ${p}: disclosure.mode=${d.mode} needs evidence`); ok = false; }
    for (const item of ev) {
      const text = byPath.get(item.file);
      if (text == null) { errors.push(`R3 ${p}: evidence file missing: ${item.file}`); ok = false; continue; }
      if (!new RegExp(item.pattern).test(text)) { errors.push(`R3 ${p}: disclosure evidence not found in ${item.file}: /${item.pattern}/`); ok = false; }
    }
    if (!ok) gapNow.add(p);
  }

  for (const p of gapNow) {
    if (!gaps.has(p)) errors.push(`R5 NEW call flow lacks a verified AI disclosure: ${p}`);
    else warnings.push(`known gap (baseline): ${p}`);
  }
  for (const p of gaps) if (!gapNow.has(p)) errors.push(`R5 baseline lists ${p} but it is compliant or gone: remove it from voice-disclosure-baseline.json`);
  return { errors, warnings, flows: found.size };
}
