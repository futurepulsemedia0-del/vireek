import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { api } = vi.hoisted(() => ({
  api: {
    fetchCatalog: vi.fn(), fetchProfile: vi.fn(), fetchStaffRole: vi.fn(), saveProfile: vi.fn(),
    fetchConsents: vi.fn(), fetchConsentHistory: vi.fn(), recordConsent: vi.fn(),
    fetchStaffVersions: vi.fn(), fetchReviewEvents: vi.fn(), transitionVersion: vi.fn(), saveDraft: vi.fn(),
  },
}));

const auth = {
  isOwner: true, permissions: { can_edit_business_profile: true }, profile: { id: 'owner-1' }, teamMember: null, user: { id: 'u1' },
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/complianceRules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/complianceRules')>('@/lib/complianceRules');
  return { ...actual, ...Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)])) };
});

import { ComplianceRulesPage } from '@/pages/ComplianceRulesPage';

const rule = {
  id: 'v1', packSlug: 'us-federal', ruleKey: 'telemarketing-hours', version: 1, jurisdiction: 'US', kind: 'quiet_hours', severity: 'block',
  appliesTo: ['call', 'sms'], title: 'Federal: no telemarketing before 8 a.m. or after 9 p.m.',
  ownerExplanation: 'Marketing messages are held until the window opens.', params: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '21:00' }], purposes: ['marketing'] },
  sourceRefs: [{ citation: '47 C.F.R. § 64.1200(c)(1)', type: 'regulation', url: 'https://www.ecfr.gov/x' }],
  status: 'approved', effectiveFrom: '2026-01-01', effectiveTo: null, legalReviewer: 'Smith LLP', legalReviewedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  toast.mockReset();
  auth.isOwner = true; auth.permissions = { can_edit_business_profile: true };
  api.fetchCatalog.mockResolvedValue([rule]);
  api.fetchProfile.mockResolvedValue({ business_state: 'TX', licenses: [], acknowledged_at: null });
  api.fetchStaffRole.mockResolvedValue(null);
  api.fetchConsents.mockResolvedValue({ total: 0, rows: [] });
});
afterEach(cleanup);

describe('ComplianceRulesPage', () => {
  it('always states that rules require legal review', async () => {
    render(<ComplianceRulesPage />);
    expect(await screen.findByText(/Rules require legal review/i)).toBeInTheDocument();
    expect(screen.getByText(/not legal advice/i)).toBeInTheDocument();
  });

  it('lists rules in force with sources, and expands the owner explanation', async () => {
    render(<ComplianceRulesPage />);
    const row = await screen.findByRole('button', { name: /Federal: no telemarketing/i });
    fireEvent.click(row);
    expect(screen.getByText(/held until the window opens/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /47 C\.F\.R\./ })).toHaveAttribute('href', 'https://www.ecfr.gov/x');
    expect(screen.getByText(/Smith LLP/)).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing is approved yet', async () => {
    api.fetchCatalog.mockResolvedValue([]);
    render(<ComplianceRulesPage />);
    expect(await screen.findByText(/No rules are in force yet/i)).toBeInTheDocument();
  });

  it('shows an error with retry when loading fails', async () => {
    api.fetchCatalog.mockRejectedValueOnce(new Error('x'));
    render(<ComplianceRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(api.fetchCatalog).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Federal: no telemarketing/i)).toBeInTheDocument();
  });

  it('blocks users without business-profile access', async () => {
    auth.isOwner = false; auth.permissions = { can_edit_business_profile: false };
    render(<ComplianceRulesPage />);
    expect(await screen.findByText(/don't have access to compliance rules/i)).toBeInTheDocument();
    expect(api.fetchCatalog).not.toHaveBeenCalled();
  });

  it('simulator: a late marketing text is blocked and explains why', async () => {
    render(<ComplianceRulesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Check a situation/i }));
    fireEvent.change(screen.getByLabelText(/What are you doing/i), { target: { value: 'sms' } });
    fireEvent.change(screen.getByLabelText(/Customer's local time/i), { target: { value: '22:30' } });
    expect(await screen.findByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText(/Outside the permitted contact window/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Customer's local time/i), { target: { value: '10:00' } });
    expect(await screen.findByText('Allowed')).toBeInTheDocument();
  });

  it('saves the business profile through the API', async () => {
    api.saveProfile.mockResolvedValue(undefined);
    render(<ComplianceRulesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Business profile/i }));
    fireEvent.change(screen.getByLabelText(/Home state/i), { target: { value: 'CA' } });
    fireEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith('CA', []));
  });

  it('validates licenses before saving', async () => {
    render(<ComplianceRulesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Business profile/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add license/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save profile/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a state and a license number/i);
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it('hides the staff review tab from non-staff and shows it to staff', async () => {
    const { unmount } = render(<ComplianceRulesPage />);
    await screen.findByRole('tab', { name: /Rules in force/i });
    expect(screen.queryByRole('tab', { name: /Rule review/i })).toBeNull();
    unmount();
    api.fetchStaffRole.mockResolvedValue('reviewer');
    api.fetchStaffVersions.mockResolvedValue([]);
    render(<ComplianceRulesPage />);
    expect(await screen.findByRole('tab', { name: /Rule review/i })).toBeInTheDocument();
  });

  it('consent ledger records a grant and reloads', async () => {
    api.recordConsent.mockResolvedValue('id');
    render(<ComplianceRulesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Consent ledger/i }));
    await screen.findByText(/No consent records yet/i);
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-123-4567' } });
    fireEvent.click(screen.getByRole('button', { name: /Save to ledger/i }));
    await waitFor(() => expect(api.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ type: 'marketing_sms', granted: true, phone: '555-123-4567' })));
    await waitFor(() => expect(api.fetchConsents.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
