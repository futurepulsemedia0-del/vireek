import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keeps docs/customer-success/* honest: every code-defined threshold they quote must still be
// in the code, and every table / function / file they name must still exist.
// Reads source as text on purpose (no imports), so it cannot drift from what the docs claim.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const DOCS = ['onboarding', 'at-risk', 'churn-save', 'expansion'] as const;
const doc = (n: string) => read(`docs/customer-success/${n}.md`);

const successTools = read('src/lib/successTools.ts');
const explorer = read('supabase/functions/_shared/staff/accountExplorer.ts');
const numberOf = (src: string, name: string): string => {
  const m = src.match(new RegExp(`(?:const|export const)\\s+${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`constant ${name} not found`);
  return m[1];
};

const migrationDir = join(root, 'supabase/migrations');
const migrations = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).map((f) => read(`supabase/migrations/${f}`)).join('\n');
const fn = (name: string) => read(`supabase/functions/${name}/index.ts`);
const corpus = [successTools, explorer, migrations, fn('manage-subscription-cancellation'), fn('manage-subscription-plan'), fn('stripe-webhook'), fn('enforce-payment-suspension')].join('\n');

describe('customer success playbooks', () => {
  it('every playbook has the required sections', () => {
    for (const n of DOCS) {
      const text = doc(n);
      for (const h of ['## Signal', '## Trigger', '## Owner', '## Actions', '## Success metric']) {
        expect(text, `${n}.md missing ${h}`).toContain(h);
      }
    }
  });

  it('quoted constants match the code', () => {
    expect(doc('onboarding')).toContain(`NEW_ACCOUNT_DAYS = ${numberOf(explorer, 'NEW_ACCOUNT_DAYS')}`);
    expect(doc('onboarding')).toContain(`NUDGE_MIN_ACCOUNT_AGE_DAYS = ${numberOf(successTools, 'NUDGE_MIN_ACCOUNT_AGE_DAYS')}`);
    expect(doc('onboarding')).toContain(`NUDGE_DEFAULT_MAX = ${numberOf(successTools, 'NUDGE_DEFAULT_MAX')}`);
    expect(doc('onboarding')).toContain(`NUDGE_SNOOZE_DAYS = ${numberOf(successTools, 'NUDGE_SNOOZE_DAYS')}`);
    expect(doc('at-risk')).toContain(`NPS_FRESH_DAYS = ${numberOf(successTools, 'NPS_FRESH_DAYS')}`);
    expect(doc('expansion')).toContain(`NPS_FRESH_DAYS = ${numberOf(successTools, 'NPS_FRESH_DAYS')}`);
  });

  it('quoted risk and health thresholds still exist in the code', () => {
    expect(successTools).toMatch(/health\.band === 'critical' \|\| score < 40 \|\| \(detractor && score < 60\)/);
    expect(successTools).toMatch(/health\.band === 'at_risk' \|\| score < 60 \|\| adoptionStalled \|\| detractor/);
    expect(successTools).toMatch(/adoptionScore < 30 && ageDays >= 30/);
    expect(successTools).toMatch(/const W_HEALTH = 0\.55;[\s\S]*const W_ADOPTION = 0\.3;[\s\S]*const W_NPS = 0\.15;/);
    expect(explorer).toMatch(/score >= 75 \? 'healthy' : score >= 50 \? 'watch' : score >= 25 \? 'at_risk' : 'critical'/);
    expect(successTools).toMatch(/if \(score >= 75\) return 'strong'/);
    expect(successTools).toMatch(/Call within 2 business days/);
  });

  it('every named table, function, key and file exists', () => {
    const names = [
      'computeHealth', 'computeSuccessRisk', 'computeAdoption', 'adoptionLevel', 'npsCategory', 'buildNudges', 'FEATURE_COPY', 'PLAYBOOKS',
      'staff_account_overview', 'staff_success_overview', 'get_my_success_snapshot', 'nps_should_prompt', 'submit_nps_response', '_nps_due',
      'success_feature_catalog', 'nps_responses', 'subscription_cancellations', 'account_module_entitlements', 'staff_audit_log',
      'subscription_status', 'dunning_stage', 'payment_failed_at', 'payment_grace_period_ends_at', 'last_payment_error', 'onboarding_completed',
      'STRIPE_WINBACK_COUPON_ID', 'cancel_at_period_end', 'cancel_scheduled', 'offer_accepted', 'accept_offer',
      'launch_ai_receptionist', 'quote_to_cash', 'run_with_your_team', 'build_recurring_revenue',
    ];
    for (const n of names) expect(corpus, `missing in code: ${n}`).toContain(n);
    for (const p of ['src/components/staff/AtRiskAccountsPanel.tsx', 'src/components/staff/AccountSuccessSection.tsx', 'src/pages/admin/StaffCustomersPage.tsx', 'docs/ENTITLEMENTS.md', 'docs/FEATURE_FLAGS.md', 'supabase/migrations/20270501000000_tasks.sql']) {
      expect(existsSync(join(root, p)), `missing file: ${p}`).toBe(true);
    }
  });

  it('every named identifier is actually mentioned by the docs', () => {
    const all = ['README', ...DOCS].map(doc).join('\n');
    for (const n of ['computeSuccessRisk', 'computeHealth', 'staff_success_overview', 'nps_responses', 'subscription_cancellations', 'dunning_stage', 'success_feature_catalog', 'account_module_entitlements']) {
      expect(all, `docs never mention ${n}`).toContain(n);
    }
  });

  it('relative links in the docs resolve', () => {
    for (const n of ['README', ...DOCS]) {
      const file = `docs/customer-success/${n}.md`;
      for (const m of doc(n).matchAll(/\]\(([^)\s]+)\)/g)) {
        const raw = m[1];
        if (/^(https?:|mailto:|#)/.test(raw)) continue;
        const target = decodeURIComponent(raw.split('#')[0]);
        if (!target) continue;
        expect(existsSync(join(root, normalize(join(dirname(file), target)))), `${file}: ${raw}`).toBe(true);
      }
    }
  });

  it('documents the flag-gated task automation that the migration really ships', () => {
    const at = doc('at-risk');
    for (const n of ['cs_auto_tasks', 'staff_cs_tasks', 'staff_sync_cs_tasks', 'staff_list_cs_tasks', 'staff_update_cs_task', 'CsTasksPanel']) {
      expect(at, `at-risk.md never mentions ${n}`).toContain(n);
    }
    expect(at).toContain('default off');
    const mig = read('supabase/migrations/20290304000000_staff_cs_tasks.sql');
    for (const n of ['staff_cs_tasks', 'staff_sync_cs_tasks', 'staff_list_cs_tasks', 'staff_update_cs_task']) expect(mig).toContain(n);
    expect(mig).toMatch(/VALUES \('cs_auto_tasks'[\s\S]*?false, 0/);
    expect(existsSync(join(root, 'src/components/staff/CsTasksPanel.tsx'))).toBe(true);
  });
});
