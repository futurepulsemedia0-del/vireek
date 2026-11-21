import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RetentionPicker, RetentionSummary } from './CloneRetentionControl';
import en from '@/locales/en/voiceCloneRetention.json';

afterEach(cleanup);

vi.mock('@/i18n/voiceCloneRetentionNamespace', () => ({
  useVoiceCloneRetentionT: () => ({
    language: 'en',
    t: (key: string, vars?: Record<string, unknown>) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(vars?.[n] ?? '')) : key;
    },
  }),
}));

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('RetentionPicker', () => {
  it('offers the presets and reports the chosen number of days', () => {
    const onChange = vi.fn();
    render(<RetentionPicker value={365} onChange={onChange} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['30 days', '90 days', '180 days', '365 days', '730 days']);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '90' } });
    expect(onChange).toHaveBeenCalledWith(90);
    expect(screen.getByText(en.picker.hint)).toBeInTheDocument();
  });
  it('can be disabled', () => {
    render(<RetentionPicker value={365} onChange={() => undefined} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});

describe('RetentionSummary', () => {
  it('shows the deletion date and days left', () => {
    render(<RetentionSummary expiresAt="2026-07-01T00:00:00.000Z" retentionDays={90} onShorten={async () => undefined} now={NOW} />);
    expect(screen.getByText(/Deleted automatically on/)).toBeInTheDocument();
    expect(screen.getByText(/Days left: 30/)).toBeInTheDocument();
  });
  it('only offers periods shorter than the current one', () => {
    render(<RetentionSummary expiresAt="2026-07-01T00:00:00.000Z" retentionDays={90} onShorten={async () => undefined} now={NOW} />);
    const opts = screen.getAllByRole('option').map((o) => o.textContent).filter(Boolean);
    expect(opts).toEqual(['30 days']);
  });
  it('offers nothing to shorten at the minimum preset', () => {
    render(<RetentionSummary expiresAt="2026-07-01T00:00:00.000Z" retentionDays={30} onShorten={async () => undefined} now={NOW} />);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('saves a shorter period and confirms it', async () => {
    const onShorten = vi.fn().mockResolvedValue(undefined);
    render(<RetentionSummary expiresAt="2026-07-01T00:00:00.000Z" retentionDays={365} onShorten={onShorten} now={NOW} />);
    expect(screen.getByRole('button', { name: en.summary.save })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: en.summary.save }));
    await waitFor(() => expect(onShorten).toHaveBeenCalledWith(90));
    expect(await screen.findByText(en.summary.saved)).toBeInTheDocument();
  });
  it('reports a failed save', async () => {
    render(<RetentionSummary expiresAt="2026-07-01T00:00:00.000Z" retentionDays={365} onShorten={async () => { throw new Error('x'); }} now={NOW} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: en.summary.save }));
    expect(await screen.findByText(en.summary.failed)).toBeInTheDocument();
  });
  it('handles a missing or due expiry without offering changes', () => {
    const { rerender } = render(<RetentionSummary expiresAt={null} retentionDays={365} onShorten={async () => undefined} now={NOW} />);
    expect(screen.getByText(en.summary.unknown)).toBeInTheDocument();
    rerender(<RetentionSummary expiresAt="2026-05-01T00:00:00.000Z" retentionDays={365} onShorten={async () => undefined} now={NOW} />);
    expect(screen.getByText(en.summary.dueNow)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
