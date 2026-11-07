// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import i18next from 'i18next';
import en from '@/locales/en/fmcheck.json';
import { FM_SEED_RULES } from '../../../supabase/functions/_shared/compliance-rules/fmSeedRules';
import type { RuleVersion } from '../../../supabase/functions/_shared/compliance-rules/types';
import { SERVICECHANNEL_DEFAULTS, type WorkOrder } from '@/lib/workOrderGuard';

const approved = (): RuleVersion[] => FM_SEED_RULES.map((r, i) => ({
  id: `p${i}`, packSlug: r.packSlug, ruleKey: r.ruleKey, version: 1, jurisdiction: r.jurisdiction, kind: r.kind, severity: r.severity,
  appliesTo: r.appliesTo, title: r.title, ownerExplanation: r.ownerExplanation, params: r.params, sourceRefs: r.sourceRefs,
  status: 'approved', effectiveFrom: '2026-11-04', effectiveTo: null,
}));

let catalog: RuleVersion[] = [];
vi.mock('@/lib/complianceRules', () => ({ fetchCatalog: vi.fn(async () => catalog) }));
vi.mock('@/i18n/fmcheckNamespace', async () => {
  const inst = i18next.createInstance();
  await inst.init({ lng: 'en', resources: { en: { fmcheck: en } }, interpolation: { escapeValue: false } });
  const t = inst.getFixedT('en', 'fmcheck');
  return { useFmcheckT: () => ({ t, language: 'en' }) };
});

import { FmCheckPanel } from '@/components/workorderguard/FmCheckPanel';

const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString();
function wo(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'o1', woNumber: 'WO-100', location: null, trade: null, priority: 'normal', nteCents: 100_000, estimateCents: null,
    receivedAt: daysAgo(3), acceptedAt: daysAgo(3), declinedAt: null, checkedInAt: null, checkInDistanceMiles: null,
    proposalStatus: 'none', proposalAmountCents: null, proposalApprovedAt: null, completedAt: daysAgo(1), invoiceNumber: null,
    invoiceSubmittedAt: null, invoiceCount: 0, invoiceLaborCents: 20_000, invoiceTechnicians: 1, invoiceMaterialsCents: 0,
    invoiceTripCents: 0, invoiceFreightCents: 0, invoiceTaxCents: 1_650, invoiceMgmtFeeCents: null, invoiceTotalCents: 21_650,
    outcome: 'open', outcomeReason: null, ...over,
  };
}

const renderPanel = (orders: WorkOrder[]) => render(<FmCheckPanel orders={orders} rules={SERVICECHANNEL_DEFAULTS} timezone="America/New_York" />);

beforeEach(() => { catalog = approved(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FmCheckPanel', () => {
  it('shows the broken rule with its source and removes the tax line from the DRAFT only, without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    renderPanel([wo()]);
    await screen.findByLabelText('Work order');
    fireEvent.change(screen.getByLabelText('Work order'), { target: { value: 'o1' } });
    fireEvent.change(screen.getByLabelText('Who you bill'), { target: { value: 'portal' } });

    const taxRule = await screen.findByText('ServiceChannel: no sales tax line when you bill ServiceChannel');
    const row = taxRule.closest('li') as HTMLElement;
    expect(within(row).getByText(/Prohibited line item/)).toBeTruthy();
    expect(within(row).getByRole('link', { name: /Trade Partner 2026 Guide/ }).getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/Draft total: \$216\.50/)).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Remove this line' }));
    await waitFor(() => expect(screen.queryByText('ServiceChannel: no sales tax line when you bill ServiceChannel')).toBeNull());
    expect(screen.getByText(/Draft total: \$200\.00/)).toBeTruthy();
    expect(screen.getByText('Line removed from the draft.').getAttribute('aria-live')).toBe('polite');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says nothing was checked when no portal rule is approved', async () => {
    catalog = approved().map((v) => ({ ...v, status: 'in_review' as const }));
    renderPanel([wo()]);
    fireEvent.change(await screen.findByLabelText('Work order'), { target: { value: 'o1' } });
    expect(await screen.findByText(/No reviewed portal rules are active yet/)).toBeTruthy();
  });

  it('does not guess: asks for the billing party instead of failing the tax rule', async () => {
    renderPanel([wo()]);
    fireEvent.change(await screen.findByLabelText('Work order'), { target: { value: 'o1' } });
    expect(await screen.findByText(/Who this invoice is billed to is not recorded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove this line' })).toBeNull();
  });

  it('keeps measured and estimated money apart in the risk view', async () => {
    renderPanel([wo({ id: 'a', woNumber: 'A', completedAt: daysAgo(20), invoiceTotalCents: 100_000 }), wo({ id: 'b', woNumber: 'B', completedAt: daysAgo(20), invoiceTotalCents: null, estimateCents: 30_000, invoiceTaxCents: null, invoiceLaborCents: null })]);
    const measured = await screen.findByText('Measured');
    expect(measured.closest('div')?.textContent).toContain('$1,000.00');
    expect(screen.getByText('Estimated', { selector: 'p' }).closest('div')?.textContent).toContain('$300.00');
  });

  it('has no axe violations (WCAG 2.x A/AA rules)', async () => {
    const { container } = renderPanel([wo()]);
    fireEvent.change(await screen.findByLabelText('Work order'), { target: { value: 'o1' } });
    fireEvent.change(screen.getByLabelText('Who you bill'), { target: { value: 'portal' } });
    await screen.findByText('ServiceChannel: no sales tax line when you bill ServiceChannel');
    const res = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
