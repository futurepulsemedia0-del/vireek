import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import en from '@/locales/en/photoProvenance.json';

const lookup = (key: string, opts: Record<string, unknown> = {}): string => {
  const raw = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as string | undefined;
  const s = typeof raw === 'string' ? raw : String(opts.defaultValue ?? key);
  return s.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(opts[n] ?? ''));
};
vi.mock('@/i18n/photoProvenanceNamespace', () => ({ usePhotoProvenanceT: () => ({ t: lookup, language: 'en' }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/photoProvenance/PhotoStatusBadge', () => ({ PhotoStatusBadge: () => <span /> }));
const summary = vi.fn();
const stored = vi.fn();
const analyse = vi.fn();
vi.mock('@/lib/photoProvenanceApi', () => ({ fetchPhotoSummary: (...a: unknown[]) => summary(...a) }));
vi.mock('@/lib/photoAuthenticityApi', () => ({ fetchAuthenticity: (...a: unknown[]) => stored(...a), requestAuthenticity: (...a: unknown[]) => analyse(...a) }));

import { PhotoAuthenticityPanel } from './PhotoAuthenticityPanel';
import type { AuthenticityReport, StoredAuthenticity } from '@/lib/photoAuthenticity';

const cap = (id: string, over = {}) => ({ id, short_id: id.toUpperCase(), status: 'unmodified', files_erased: false, ...over });
const rep = (consistency: AuthenticityReport['consistency'], c2pa: Partial<AuthenticityReport['c2pa']> = {}): StoredAuthenticity => ({
  capture_id: 'c1', analyzer_version: 'pa-1.0.0', analyzed_at: '2026-11-10T10:00:00Z',
  report: {
    analyzerVersion: 'pa-1.0.0', analyzedSha256: 'a'.repeat(64),
    metadata: { format: 'jpeg', parsedCompletely: true, hasExif: true, hasXmp: false, hasGps: false, camera: null, software: null, exifCapturedAt: null },
    c2pa: { status: 'not_present', validation: 'unknown', trust: 'not_evaluated', problems: [], declaresGeneratedMedia: false, declaresEdits: false, signer: null, ...c2pa },
    consistency,
  },
});

beforeEach(() => { summary.mockReset(); stored.mockReset(); analyse.mockReset(); });

describe('PhotoAuthenticityPanel', () => {
  it('always shows the "not a verdict" notice, and the loading state first', async () => {
    summary.mockReturnValue(new Promise(() => {}));
    stored.mockReturnValue(new Promise(() => {}));
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(screen.getByRole('note')).toHaveTextContent(/not a verdict/i);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });
  it('shows the empty state when the job has no sealed photos', async () => {
    summary.mockResolvedValue({ captures: [] });
    stored.mockResolvedValue(new Map());
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByText(en.authenticity.empty)).toBeInTheDocument();
  });
  it('shows an error with retry when loading fails', async () => {
    summary.mockRejectedValueOnce(new Error('x'));
    stored.mockResolvedValue(new Map());
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(en.authenticity.loadFailed);
    summary.mockResolvedValue({ captures: [] });
    fireEvent.click(screen.getByRole('button', { name: en.authenticity.retry }));
    expect(await screen.findByText(en.authenticity.empty)).toBeInTheDocument();
  });
  it('renders a score with reasons and the C2PA line', async () => {
    summary.mockResolvedValue({ captures: [cap('c1')] });
    stored.mockResolvedValue(new Map([['c1', rep({ kind: 'metadata_consistency', notAVerdict: true, confidence: 62, level: 'moderate', reasons: [{ code: 'editing_software', effect: 'weakens', weight: -15, detail: { software: 'Adobe Photoshop' } }] })]]));
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByText(/62 out of 100/)).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '62');
    expect(screen.getByText(/photo-editing software: Adobe Photoshop/)).toBeInTheDocument();
    expect(screen.getByText(/No Content Credentials found/)).toBeInTheDocument();
  });
  it('shows NO number when there is not enough metadata', async () => {
    summary.mockResolvedValue({ captures: [cap('c1')] });
    stored.mockResolvedValue(new Map([['c1', rep({ kind: 'metadata_consistency', notAVerdict: true, confidence: null, level: 'insufficient', reasons: [{ code: 'no_metadata', effect: 'info', weight: 0 }] })]]));
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByText(en.authenticity.level.insufficient)).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText(/out of 100/)).toBeNull();
  });
  it('an unknown reason code from a newer analyzer falls back to a neutral sentence, not a raw key', async () => {
    summary.mockResolvedValue({ captures: [cap('c1')] });
    stored.mockResolvedValue(new Map([['c1', rep({ kind: 'metadata_consistency', notAVerdict: true, confidence: 50, level: 'moderate', reasons: [{ code: 'brand_new_check', effect: 'info', weight: 0 }] })]]));
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByText(en.authenticity.reason.unknown)).toBeInTheDocument();
    expect(screen.queryByText(/brand_new_check/)).toBeNull();
  });
  it('runs a check on demand, then reloads; erased photos cannot be checked', async () => {
    summary.mockResolvedValue({ captures: [cap('c1'), cap('c2', { files_erased: true })] });
    stored.mockResolvedValueOnce(new Map());
    render(<PhotoAuthenticityPanel jobId="j1" />);
    expect(await screen.findByText(en.authenticity.erased)).toBeInTheDocument();
    analyse.mockResolvedValue({});
    stored.mockResolvedValue(new Map([['c1', rep({ kind: 'metadata_consistency', notAVerdict: true, confidence: 80, level: 'strong', reasons: [] })]]));
    fireEvent.click(screen.getAllByRole('button', { name: en.authenticity.run })[0]);
    await waitFor(() => expect(analyse).toHaveBeenCalledWith('c1'));
    expect(await screen.findByText(/80 out of 100/)).toBeInTheDocument();
  });
  it('never renders markup from file-derived text', async () => {
    summary.mockResolvedValue({ captures: [cap('c1')] });
    stored.mockResolvedValue(new Map([['c1', rep({ kind: 'metadata_consistency', notAVerdict: true, confidence: 50, level: 'moderate', reasons: [{ code: 'editing_software', effect: 'weakens', weight: -15, detail: { software: '<img src=x onerror=alert(1)>' } }] })]]));
    const { container } = render(<PhotoAuthenticityPanel jobId="j1" />);
    await screen.findByText(/photo-editing software/);
    expect(container.querySelector('img')).toBeNull();
  });
});
