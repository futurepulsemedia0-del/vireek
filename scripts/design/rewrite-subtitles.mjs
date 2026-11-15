#!/usr/bin/env node
// scripts/design/rewrite-subtitles.mjs
//
// Rewrites the one-paragraph subtitle under the <h1> of 17 pages whose copy is
// abstract or promotional. Meaning and claims are unchanged; only wording.
//
//   node scripts/design/rewrite-subtitles.mjs          # dry run
//   node scripts/design/rewrite-subtitles.mjs --write  # apply
//
// Safety: each OLD text must match exactly once (whitespace/line breaks are
// tolerated). Anything else is reported and left untouched. NEW text may not
// contain { } < > so JSX can never break.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');

const T = [
  ['AdaptiveDiagnosticsPage',
   'Vireek asks the one question that narrows the diagnosis fastest, re-ranks causes after every answer, and learns from every verified repair.',
   'Asks the question that narrows down the fault fastest and re-ranks the likely causes after each answer. Every verified repair improves the next diagnosis.'],
  ['BusinessDigitalTwinPage',
   'Simulate the future before you act. Stack levers, see the range of outcomes, then close the loop later with what actually happened.',
   'Test a decision before you make it. Combine changes, see the range of likely outcomes, then compare with what actually happened.'],
  ['BusinessImmuneSystemPage',
   'Detects operational, financial, and reputational anomalies, contains them, and guides recovery — before they become real damage.',
   'Flags unusual operational, financial and reputation problems early, limits the damage and walks you through recovery.'],
  ['BusinessWorldModelPage',
   'One live graph of your customers, properties, assets, jobs, technicians, invoices, communications and events — with what caused what, layered on top.',
   'Customers, properties, equipment, jobs, technicians, invoices, messages and events in one connected view, including what led to what.'],
  ['CausalShockSimulatorPage',
   'Ask "what if" once — see the domino effect on customers, SLA, cash, jobs, crew and reputation, plus a concrete response plan, all grounded in your real account data.',
   'Ask “what if” and see how it ripples through customers, SLAs, cash, jobs, crew and reputation, with a response plan. Based on your own account data.'],
  ['CausalWorldSimulatorPage',
   '"If I do this, what happens — and what would happen if I didn\'t?" Grounded in your data and real outcomes from similar businesses.',
   '“If I do this, what happens, and what happens if I don’t?” Answers use your data and real outcomes from similar businesses.'],
  ['CommunityPage',
   'A free space for Vireek customers to compare notes on dispatch, call scripts, and everything else that goes into running a service business — not just a support channel.',
   'A free space for Vireek customers to compare notes on dispatch, call scripts and the rest of running a service business. It is not a support channel.'],
  ['CompoundingFlywheelPage',
   'Every confirmed lesson and every recurring, confirmed threat gets turned into a real action — so the business keeps getting smarter and more automated on its own.',
   'Confirmed lessons and recurring threats turn into concrete actions, so more of the business handles itself over time.'],
  ['ContextEnginePage',
   'Before a technician leaves, Vireek connects the customer, property, weather, equipment, history, permits, parts and technician into one Context Graph, so you dispatch knowing the real situation.',
   'Before a technician leaves, Vireek pulls the customer, property, weather, equipment, history, permits, parts and technician into one view, so you dispatch with the full picture.'],
  ['DurationIntelligencePage',
   'Learns how long each job really takes — by job type, technician, equipment and customer — and tells you how sure it is.',
   'Learns how long jobs really take by job type, technician, equipment and customer, and shows how confident it is.'],
  ['IdentityLearnerPage',
   'Learned from what you actually decide — not what you said once. Flags when who you are has changed.',
   'Built from the decisions you actually make, not what you said once. Flags when your priorities change.'],
  ['OperationalTruthPage',
   'Every fact an AI agent acts on carries its source, evidence, freshness, confidence and conflict status. Agents cannot decide on stale or disputed data.',
   'Every fact an AI agent acts on shows its source, evidence, age, confidence and any conflict. Agents can’t act on stale or disputed data.'],
  ['OpsExperimentsPage',
   'Turn any operational decision into a test: state the hypothesis, change one thing, compare against a control, measure the outcome, estimate the true effect and keep what was learned.',
   'Turn an operational decision into a test. State your hypothesis, change one thing, compare against a control, measure the result and keep what you learn.'],
  ['QuoteTruthEnginePage',
   'Is this quote actually reasonable? See the expected price range, the chance the customer says no, and the risk they later feel overcharged — before you send it.',
   'Is this quote reasonable? See the expected price range, the chance the customer says no and the risk they feel overcharged later, before you send it.'],
  ['SeasonalRevenueStabilizerPage',
   'Forecasts your peak and valley weeks per service line from your own job history, then proposes campaigns, offers, pricing and staffing moves to flatten revenue and cash flow. Every action is approved by you and measured afterwards.',
   'Forecasts your busy and slow weeks for each service line from your own job history, then proposes campaigns, offers, pricing and staffing changes to even out revenue and cash flow. You approve every action, and results are measured afterwards.'],
  ['SelfHealingPage',
   'When a technician runs late, the business repairs itself — notify, reassign, re-route, reschedule downstream jobs, reserve parts, and call in the contractor network if needed. No one has to click anything.',
   'When a technician runs late, Vireek notifies the people involved, reassigns or re-routes, reschedules later jobs, reserves parts and calls in a contractor if needed. No manual clicking required.'],
  ['TemporalRegulationPage',
   'Jurisdiction → code → permit → license → inspection → environmental rule, versioned by effective date. Ask what was in force on any day — and what we knew at the time. Every job can seal that answer as proof.',
   'Rules run from jurisdiction to code, permit, license, inspection and environmental requirement, each versioned by effective date. Look up what applied on any day and what we knew then. Each job can save that answer as proof.'],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let ok = 0;
let bad = 0;
for (const [page, oldText, newText] of T) {
  const file = join(ROOT, 'src/pages', `${page}.tsx`);
  if (/[{}<>]/.test(newText)) { console.log(`SKIP ${page}: new text contains JSX-unsafe characters`); bad++; continue; }
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { console.log(`MISSING ${page}.tsx`); bad++; continue; }
  const re = new RegExp(oldText.split(/\s+/).map(esc).join('\\s+'), 'g');
  const matches = src.match(re) ?? [];
  if (matches.length !== 1) { console.log(`NO UNIQUE MATCH ${page}: found ${matches.length}`); bad++; continue; }
  if (WRITE) writeFileSync(file, src.replace(re, () => newText));
  console.log(`${WRITE ? 'REWROTE' : 'OK (dry)'} ${page}`);
  ok++;
}
console.log(`\n${ok} ready/applied, ${bad} skipped`);
