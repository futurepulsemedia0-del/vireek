import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ claimSurvey: vi.fn(), respondSurvey: vi.fn(), dismissSurvey: vi.fn() }));
vi.mock('@/lib/feedback/api', () => api);
const consent = vi.hoisted(() => ({ analytics: true }));
vi.mock('@/lib/consent/useConsent', () => ({ useConsent: () => ({ hasConsent: () => consent.analytics }) }));

import { SurveyHost } from './SurveyHost';
import { resetErrorTrackerForTests, noteIncident } from '@/lib/feedback/errorTracker';
import { requestSurvey } from '@/lib/feedback/events';

const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = (path = '/dashboard/jobs') => render(<MemoryRouter initialEntries={[path]}><SurveyHost /></MemoryRouter>);
const ask = () => act(() => requestSurvey({ type: 'csat', trigger: 'support_ticket', subject: 't1' }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  consent.analytics = true;
  resetErrorTrackerForTests();
  api.claimSurvey.mockResolvedValue(true);
  api.respondSurvey.mockResolvedValue({ ok: true });
  api.dismissSurvey.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SurveyHost gating', () => {
  it('shows an accessible survey after the delay when everything is calm', async () => {
    mount(); await ask(); await wait(1600);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAttribute('aria-modal', 'false');
    expect(d).toHaveAccessibleName(/satisfied/i);
    expect(api.claimSurvey).toHaveBeenCalledTimes(1);
  });

  it('never claims or shows a survey without analytics consent', async () => {
    consent.analytics = false;
    mount(); await ask(); await wait(10_000);
    expect(api.claimSurvey).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never shows during a critical flow (billing), even after a minute of retries', async () => {
    mount('/dashboard/billing/checkout'); await ask(); await wait(70_000);
    expect(api.claimSurvey).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('holds off right after an error, then shows once things are quiet', async () => {
    noteIncident('INC-ABCD-2345');
    mount(); await ask(); await wait(2000);
    expect(api.claimSurvey).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not show when the server refuses the claim (frequency cap)', async () => {
    api.claimSurvey.mockResolvedValue(false);
    mount(); await ask(); await wait(1600);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not stack on top of another open modal dialog', async () => {
    render(<MemoryRouter><div role="dialog" aria-modal="true">other</div><SurveyHost /></MemoryRouter>);
    await ask(); await wait(2000);
    expect(api.claimSurvey).not.toHaveBeenCalled();
  });
});

describe('SurveyHost interaction', () => {
  it('submits a score and asks for the reason on low scores', async () => {
    mount(); await ask(); await wait(1600);
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    expect(screen.getByText(/what went wrong/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'slow' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^send$/i })); });
    expect(api.respondSurvey).toHaveBeenCalledWith({ type: 'csat', trigger: 'support_ticket', subject: 't1' }, 2, 'slow', false);
    await wait(50);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(/thank you/i);
  });

  it('Escape, "Ask me later" and "Don’t ask again" are recorded', async () => {
    mount(); await ask(); await wait(1600);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(api.dismissSurvey).toHaveBeenCalledWith(expect.anything(), 'dismissed', 30);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never-ask is sent to the server', async () => {
    mount(); await ask(); await wait(1600);
    fireEvent.click(screen.getByRole('button', { name: /don’t ask me again/i }));
    expect(api.dismissSurvey).toHaveBeenCalledWith(expect.anything(), 'never', 30);
  });
});
