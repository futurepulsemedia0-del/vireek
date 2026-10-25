import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiDisclosureLedgerPage } from './AiDisclosureLedgerPage';
import { EMPTY_SUMMARY, type LedgerRow } from '@/lib/aiDisclosureLedger';

const api = vi.hoisted(() => ({
  PAGE_SIZE: 25,
  fetchSummary: vi.fn(),
  fetchLedgerPage: vi.fn(),
  fetchAllForExport: vi.fn(),
  fetchVersions: vi.fn(),
  fetchDriftChecks: vi.fn(),
  fetchScriptConfig: vi.fn(),
  saveScriptLanguage: vi.fn(),
  runDriftCheck: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/lib/aiDisclosureLedgerApi', () => api);
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ROW: LedgerRow = {
  id: 'r1', vapi_call_id: 'vc-123', call_id: 'c1', version_id: 'v1', language: 'en', selection_reason: 'default_fallback',
  disclosure_text: 'This call is answered by an AI voice assistant, not a live person.', disclosure_sha256: 'a'.repeat(64),
  status: 'missing', matched_via: null, delivered_at: null, offset_seconds: null, transcript_char_offset: null,
  matched_turn_index: null, match_score: 0.1, evidence_excerpt: 'Hello, thanks for calling Acme.', transcript_sha256: 'b'.repeat(64),
  detected_language: null, language_mismatch: false, call_started_at: '2027-01-01T10:00:00Z', call_duration_seconds: 60,
  alerted_at: null, created_at: '2027-01-01T10:01:00Z', calls: { caller_name: 'Dana Whitfield', caller_phone: null, call_datetime: null },
};
const DRIFT_OK = { id: 'd1', checked_at: new Date().toISOString(), trigger_source: 'manual', vapi_assistant_id: 'a1', status: 'in_sync', reason: 'exact_match', expected_text: 'x', live_first_message: 'x', similarity: 1 };
const DRIFT_BAD = { ...DRIFT_OK, status: 'drift', reason: 'disclosure_missing', live_first_message: 'Hi, thanks for calling Acme.' };

function setup(over: Partial<Record<string, unknown>> = {}) {
  auth.value = { profile: { id: 'owner1' }, teamMember: null, isOwner: true, permissions: {}, ...over };
  return render(<MemoryRouter><AiDisclosureLedgerPage /></MemoryRouter>);
}

describe('AiDisclosureLedgerPage', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
    api.fetchSummary.mockResolvedValue({ ...EMPTY_SUMMARY, total: 10, delivered: 9, missing: 1 });
    api.fetchLedgerPage.mockResolvedValue({ rows: [ROW], total: 1 });
    api.fetchVersions.mockResolvedValue([]);
    api.fetchDriftChecks.mockResolvedValue([DRIFT_OK]);
    api.fetchScriptConfig.mockResolvedValue({ script: 'This call is answered by an AI voice assistant, not a live person.', language: 'en' });
    api.runDriftCheck.mockResolvedValue(undefined);
    toast.mockReset();
  });

  it('shows a loading state, then summary tiles and the call list', async () => {
    setup();
    expect(screen.getByLabelText('Loading disclosure ledger')).toBeTruthy();
    expect(await screen.findByText('Dana Whitfield')).toBeTruthy();
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
  });

  it('expands a row to show the exact wording, evidence and hashes', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /dana whitfield/i }));
    const detail = await screen.findByTestId('ledger-row-detail');
    expect(detail.textContent).toContain('answered by an AI voice assistant');
    expect(detail.textContent).toContain('Hello, thanks for calling Acme.');
    expect(detail.textContent).toContain('vc-123');
  });

  it('shows the exact sentence to paste when the live assistant has drifted', async () => {
    api.fetchDriftChecks.mockResolvedValue([DRIFT_BAD]);
    setup();
    expect(await screen.findByText('Out of sync')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy sentence/i })).toBeTruthy();
    expect(screen.getByText("The live first message doesn't contain your disclosure.")).toBeTruthy();
  });

  it('"Check now" runs the scan and refreshes the drift history', async () => {
    setup();
    await screen.findByText('Dana Whitfield');
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    await waitFor(() => expect(api.runDriftCheck).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Checked your live assistant.', 'success'));
  });

  it('shows an error state with retry when loading fails', async () => {
    api.fetchSummary.mockRejectedValueOnce(new Error('boom'));
    setup();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Dana Whitfield')).toBeTruthy();
  });

  it('shows an empty state when no calls have been verified yet', async () => {
    api.fetchLedgerPage.mockResolvedValue({ rows: [], total: 0 });
    setup();
    expect(await screen.findByText('No calls verified yet')).toBeTruthy();
  });

  it('shows a filtered-empty state with a way back', async () => {
    setup();
    await screen.findByText('Dana Whitfield');
    api.fetchLedgerPage.mockResolvedValue({ rows: [], total: 0 });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'late' } });
    expect(await screen.findByText('No calls match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => expect(api.fetchLedgerPage).toHaveBeenLastCalledWith('owner1', expect.objectContaining({ status: 'all' })));
  });

  it('scopes every query to the account owner, also for team members', async () => {
    setup({ isOwner: false, profile: { id: 'staff1' }, teamMember: { account_owner_id: 'owner9' }, permissions: { can_edit_business_profile: true } });
    await screen.findByText('Dana Whitfield');
    expect(api.fetchLedgerPage).toHaveBeenCalledWith('owner9', expect.any(Object));
    expect(api.fetchVersions).toHaveBeenCalledWith('owner9');
  });

  it('blocks team members without the permission', () => {
    setup({ isOwner: false, teamMember: { account_owner_id: 'owner9' }, permissions: {} });
    expect(screen.getByText("You don't have access to this page")).toBeTruthy();
    expect(api.fetchSummary).not.toHaveBeenCalled();
  });

  it('exports a CSV download for the selected range', async () => {
    api.fetchAllForExport.mockResolvedValue({ rows: [ROW], truncated: false });
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    setup();
    await screen.findByText('Dana Whitfield');
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Audit export ready.', 'success');
  });
});
