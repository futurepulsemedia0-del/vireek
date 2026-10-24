import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { api } = vi.hoisted(() => ({
  api: { fetchStaffVersions: vi.fn(), fetchReviewEvents: vi.fn(), transitionVersion: vi.fn(), saveDraft: vi.fn() },
}));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/complianceRules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/complianceRules')>('@/lib/complianceRules');
  return { ...actual, ...Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)])) };
});

import { ReviewQueue, parseForm } from '@/components/compliance-rules/ReviewQueue';

const v = {
  id: 'v1', packSlug: 'us-tx', packName: 'Texas', ruleKey: 'license-display', version: 1, jurisdiction: 'US-TX', kind: 'license_display', severity: 'require',
  appliesTo: ['quote'], title: 'Texas: show your license', ownerExplanation: 'Texas requires the license number on bids.', params: { licenseLabel: 'TDLR number' },
  sourceRefs: [{ citation: 'Tex. Occ. Code § 1302.352', type: 'statute' }], status: 'in_review', effectiveFrom: '2026-10-21', effectiveTo: null,
  authoredByEmail: 'a@x.com', authoredBy: 'author-1', submittedAt: null, reviewedByEmail: null, reviewedAt: null, reviewNotes: null, createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.mockReset();
  api.fetchStaffVersions.mockResolvedValue([v]);
  api.fetchReviewEvents.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ReviewQueue', () => {
  it('warns that legal review is required and lists versions in review first', async () => {
    render(<ReviewQueue role="reviewer" userId="rev-1" />);
    expect(await screen.findByText(/Legal review required/i)).toBeInTheDocument();
    expect(screen.getByText('Texas: show your license')).toBeInTheDocument();
  });

  it('approving requires notes and a named legal reviewer, then calls the API', async () => {
    api.transitionVersion.mockResolvedValue('approved');
    render(<ReviewQueue role="reviewer" userId="rev-1" />);
    fireEvent.click(await screen.findByText('Texas: show your license'));
    fireEvent.change(await screen.findByLabelText(/Review notes/i), { target: { value: 'Checked against statute text' } });
    fireEvent.change(screen.getByLabelText(/Legal reviewer/i), { target: { value: 'Smith LLP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.transitionVersion).toHaveBeenCalledWith('v1', 'approve', 'Checked against statute text', 'Smith LLP'));
  });

  it("does not offer Approve on the reviewer's own draft", async () => {
    api.fetchStaffVersions.mockResolvedValue([{ ...v, authoredBy: 'rev-1' }]);
    render(<ReviewQueue role="reviewer" userId="rev-1" />);
    fireEvent.click(await screen.findByText('Texas: show your license'));
    await screen.findByRole('button', { name: 'Request changes' });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('shows the server error when a transition fails', async () => {
    const { ComplianceError } = await import('@/lib/complianceRules');
    api.transitionVersion.mockRejectedValue(new ComplianceError('invalid', 'review notes (min 10 characters) are required'));
    render(<ReviewQueue role="admin" userId="adm" />);
    fireEvent.click(await screen.findByText('Texas: show your license'));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('review notes (min 10 characters) are required', 'error'));
  });
});

describe('parseForm', () => {
  const base = {
    packSlug: 'us-tx', packName: 'Texas', jurisdiction: 'US-TX', ruleKey: 'license-display', kind: 'license_display' as const, severity: 'require' as const,
    appliesTo: ['quote' as const], title: 'Texas: show your license', ownerExplanation: 'Texas requires the license number on bids.',
    paramsText: '{"licenseLabel":"TDLR number"}', sourcesText: '[{"citation":"Tex. Occ. Code § 1302.352"}]', effectiveFrom: '2026-10-21', effectiveTo: '',
  };
  it('accepts a valid form', () => {
    const r = parseForm(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.effectiveTo).toBeNull();
  });
  it('reports bad JSON, bad slugs and rule-level problems together', () => {
    expect(parseForm({ ...base, paramsText: '{nope' })).toEqual({ ok: false, errors: ['Parameters are not valid JSON.'] });
    const r = parseForm({ ...base, packSlug: 'US TX', sourcesText: '[]' });
    expect(r.ok).toBe(false);
    const r2 = parseForm({ ...base, sourcesText: '[]', paramsText: '{}' });
    expect(r2.ok && r2).toBe(false);
    if (!r2.ok) expect(r2.errors.join('|')).toMatch(/source reference/);
  });
});
