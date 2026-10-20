import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CallDispositionBreakdown } from './CallDispositionBreakdown';

const api = vi.hoisted(() => ({ fetchDispositionSummary: vi.fn() }));
vi.mock('@/lib/callDispositionApi', () => api);

const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-10-20T23:59:59Z');

const SUMMARY = {
  total_calls: 20,
  tagged: 10,
  ai_reviewed: 4,
  ai_agreed: 3,
  by_outcome: [
    { outcome: 'booked', total: 4, ai_count: 1, with_task: 2, tasks_done: 1 },
    { outcome: 'quoted', total: 2, ai_count: 0, with_task: 2, tasks_done: 0 },
    { outcome: 'no_answer', total: 2, ai_count: 2, with_task: 1, tasks_done: 0 },
    { outcome: 'spam', total: 2, ai_count: 0, with_task: 0, tasks_done: 0 },
  ],
};

const renderIt = () =>
  render(
    <MemoryRouter>
      <CallDispositionBreakdown start={START} end={END} />
    </MemoryRouter>,
  );

describe('CallDispositionBreakdown', () => {
  beforeEach(() => api.fetchDispositionSummary.mockReset());

  it('loads for the selected range and renders each outcome with its share', async () => {
    api.fetchDispositionSummary.mockResolvedValue(SUMMARY);
    renderIt();
    expect(screen.getByLabelText('Loading call dispositions')).toBeTruthy();
    const list = await screen.findByTestId('disposition-rows');
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByText('Booked')).toBeTruthy();
    expect(screen.getByText(/4 · 40%/)).toBeTruthy();
    expect(api.fetchDispositionSummary).toHaveBeenCalledWith(START, END);
  });

  it('shows close rate, noise and follow-up coverage', async () => {
    api.fetchDispositionSummary.mockResolvedValue(SUMMARY);
    renderIt();
    await screen.findByTestId('disposition-rows');
    expect(screen.getByText('67%')).toBeTruthy(); // close rate 4 / (4 + 2)
    expect(screen.getByText('20%')).toBeTruthy(); // noise 2 / 10
    expect(screen.getByText('75%')).toBeTruthy(); // follow-up coverage; also AI agreement text below
    expect(screen.getByText(/agreed with the AI on 75% of 4 reviewed calls/i)).toBeTruthy();
  });

  it('points at untagged calls', async () => {
    api.fetchDispositionSummary.mockResolvedValue(SUMMARY);
    renderIt();
    const note = await screen.findByTestId('untagged-note');
    expect(note.textContent).toContain('10 calls still need an outcome');
    expect(screen.getByRole('link', { name: /review calls/i }).getAttribute('href')).toBe('/dashboard/calls');
  });

  it('explains how to get data when calls exist but none are tagged', async () => {
    api.fetchDispositionSummary.mockResolvedValue({ ...SUMMARY, tagged: 0, ai_reviewed: 0, ai_agreed: 0, by_outcome: [] });
    renderIt();
    expect(await screen.findByText(/Tag calls with an outcome/i)).toBeTruthy();
    expect(screen.queryByTestId('disposition-rows')).toBeNull();
  });

  it('handles a period with no calls at all', async () => {
    api.fetchDispositionSummary.mockResolvedValue({ total_calls: 0, tagged: 0, ai_reviewed: 0, ai_agreed: 0, by_outcome: [] });
    renderIt();
    expect(await screen.findByText('There are no calls in this period.')).toBeTruthy();
    expect(screen.queryByTestId('untagged-note')).toBeNull();
  });

  it('shows an error and retries', async () => {
    api.fetchDispositionSummary.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(SUMMARY);
    renderIt();
    expect(await screen.findByText('Could not load call dispositions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByTestId('disposition-rows');
    await waitFor(() => expect(api.fetchDispositionSummary).toHaveBeenCalledTimes(2));
  });
});
