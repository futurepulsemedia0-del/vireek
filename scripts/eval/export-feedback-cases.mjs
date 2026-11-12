#!/usr/bin/env node
// scripts/eval/export-feedback-cases.mjs   (Node >= 22.18)
//   node scripts/eval/export-feedback-cases.mjs candidates.json > eval/vertical-ai/drafts/feedback-drafts.json
// Input: JSON array exported by a human from call_eval_candidates (id, reason, scrubbed_transcript, consent_at).
// Output: UNLABELED draft cases. Only rows with consent_at and a transcript are used. "expect" is deliberately null:
// a person must label urgency/handoff/price before a draft is moved into eval/vertical-ai/cases.*.json (the gate never reads drafts/).
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = rows.filter((r) => r.consent_at && r.scrubbed_transcript).map((r, i) => ({
  id: `fb-${String(r.id).slice(0, 8)}`, split: 'feedback_draft', trade: null, category: `feedback_${r.reason}`,
  text: String(r.scrubbed_transcript).slice(0, 600), expect: null, needs_label: true, source_candidate: r.id, seq: i + 1,
}));
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
console.error(`${out.length} draft(s) from ${rows.length} candidate(s); ${rows.length - out.length} skipped (no consent or no transcript).`);
