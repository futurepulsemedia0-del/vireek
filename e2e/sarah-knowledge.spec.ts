// e2e/sarah-knowledge.spec.ts — dashboard-first onboarding. Supabase (auth, REST, edge functions) is fully mocked;
// no real call, scrape or model request is ever made. Needs a build with VITE_SUPABASE_URL set (same as first-call.spec.ts).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PROFILE, USER, calls, mockSupabase, signIn, type Tables } from './helpers/mockSupabase';

const RUN = {
  id: '44444444-4444-4444-8444-444444444444', status: 'interviewing', locale: 'en', website_url: 'https://acme.com',
  started_at: new Date(Date.now() - 3600_000).toISOString(), first_draft_at: null, readiness_passed: false, readiness_score: null,
  test_call_confirmed_at: null, live_at: null,
};
const FIELDS = [
  { id: 'f1', key: 'business_name', value: 'Acme Heating', prev_value: null, confidence: 'high', assumed: false, sensitive: false, origin: 'source', source_id: null, citation: null, status: 'approved', edit_count: 0 },
  { id: 'f2', key: 'hours', value: { mon: { open: '08:00', close: '17:00' } }, prev_value: null, confidence: 'medium', assumed: false, sensitive: false, origin: 'source', source_id: null, citation: null, status: 'pending', edit_count: 0 },
];
const base = (extra: Tables = {}): Tables => ({ profiles: [PROFILE], team_members: [], business_profile: [], sarah_learn_runs: [], sarah_learn_fields: [], ...extra });

test.beforeEach(async ({ page }) => { await signIn(page); });

test('a brand-new owner lands on the dashboard and is never bounced to onboarding', async ({ page }) => {
  await mockSupabase(page, { tables: base() });
  await page.goto('/dashboard');
  await expect(page.getByTestId('sarah-knowledge-card')).toHaveAttribute('data-stage', 'not_started');
  await page.waitForTimeout(1500); // a guard redirect would have fired by now
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/dashboard/calls');
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/dashboard\/calls$/);
});

test('the legacy /onboarding URL opens the in-dashboard Sarah hub', async ({ page }) => {
  await mockSupabase(page, { tables: base() });
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/dashboard\/sarah$/);
  await expect(page.getByRole('link', { name: 'Sarah Knowledge' }).first()).toBeVisible();
});

test('entering a website hands off to the hub with the field pre-filled', async ({ page }) => {
  await mockSupabase(page, { tables: base() });
  await page.goto('/dashboard');
  await page.getByLabel('Your website').fill('acme-plumbing.com');
  await page.getByRole('button', { name: 'Let Sarah read it' }).click();
  await expect(page).toHaveURL(/\/dashboard\/sarah\?website=https%3A%2F%2Facme-plumbing\.com%2F$/);
  await expect(page.getByLabel('Your website')).toHaveValue('https://acme-plumbing.com/');
});

test('learning state: score is shown and one question is answered inline', async ({ page }) => {
  await mockSupabase(page, {
    tables: base({ sarah_learn_runs: [RUN], sarah_learn_fields: FIELDS }),
    functions: {
      'sarah-learn-interview': (b) =>
        b.action === 'answer'
          ? { question: null, remaining: 0, answered: 1, max_questions: 7, estimate_seconds: 0, done: true }
          : { question: { id: 'diagnostic_fee', key: 'diagnostic_fee', text: 'Do you charge a diagnostic fee?', choices: [{ value: 'No fee', label: 'No fee' }] }, remaining: 3, answered: 0, max_questions: 7, estimate_seconds: 30, done: false },
    },
  });
  await page.goto('/dashboard');
  const card = page.getByTestId('sarah-knowledge-card');
  await expect(card).toHaveAttribute('data-stage', 'learning');
  await expect(card.getByRole('progressbar')).toBeVisible();
  await card.getByRole('button', { name: 'Answer a quick question' }).click();
  await expect(page.getByText('Do you charge a diagnostic fee?')).toBeVisible();
  await page.getByRole('button', { name: 'No fee' }).click();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText("That's everything Sarah needed for now.")).toBeVisible();
  expect(calls.find((c) => c.fn === 'sarah-learn-interview' && c.body.action === 'answer')?.body.answer).toBe('No fee');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('"Not now" keeps the card collapsed after a reload', async ({ page }) => {
  await mockSupabase(page, { tables: base({ sarah_learn_runs: [RUN], sarah_learn_fields: FIELDS }) });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Not now' }).click();
  await page.reload();
  await expect(page.getByTestId('sarah-knowledge-card')).toHaveAttribute('data-snoozed', 'true');
});

test('a team member without profile-edit permission never sees the card', async ({ page }) => {
  const member = { ...PROFILE, role: 'staff', onboarding_completed: true };
  await mockSupabase(page, { tables: base({ profiles: [member], team_members: [{ account_owner_id: USER.id, member_email: USER.email, permissions: {} }] }) });
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('sarah-knowledge-card')).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`card has no WCAG 2.2 AA violations [${scheme}]`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockSupabase(page, { tables: base({ sarah_learn_runs: [RUN], sarah_learn_fields: FIELDS }) });
    await page.goto('/dashboard');
    await expect(page.getByTestId('sarah-knowledge-card')).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[data-testid="sarah-knowledge-card"]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
