import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ claimPmf: vi.fn(), respondPmf: vi.fn(), dismissPmf: vi.fn() }));
vi.mock('@/lib/pmfApi', () => api);
const consent = vi.hoisted(() => ({ analytics: true }));
vi.mock('@/lib/consent/useConsent', () => ({ useConsent: () => ({ hasConsent: () => consent.analytics }) }));
vi.mock('@/i18n/pmfNamespace', () => ({ usePmfT: () => ({ t: (k: string) => k, language: 'en' }) }));

import { PMF_PROMPT_DELAY_MS, PmfPrompt, resetPmfPromptThrottleForTests } from './PmfPrompt';
import { noteIncident, resetErrorTrackerForTests } from '@/lib/feedback/errorTracker';

const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = (path = '/dashboard/jobs') => render(<MemoryRouter initialEntries={[path]}><PmfPrompt /></MemoryRouter>);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  consent.analytics = true;
  resetErrorTrackerForTests();
  resetPmfPromptThrottleForTests();
  api.claimPmf.mockResolvedValue(true);
  api.respondPmf.mockResolvedValue({ ok: true });
  api.dismissPmf.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('PmfPrompt', () => {
  it('waits for the delay, then claims from the server and asks', async () => {
    mount();
    await wait(PMF_PROMPT_DELAY_MS - 1000);
    expect(api.claimPmf).not.toHaveBeenCalled();
    await wait(1500);
    expect(api.claimPmf).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('without analytics consent nothing is requested from the server and nothing is shown', async () => {
    consent.analytics = false;
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 70_000);
    expect(api.claimPmf).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never asks on a critical route', async () => {
    mount('/dashboard/billing');
    await wait(PMF_PROMPT_DELAY_MS + 70_000);
    expect(api.claimPmf).not.toHaveBeenCalled();
  });

  it('stays quiet after a recent error', async () => {
    noteIncident('inc_1');
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 10_000);
    expect(api.claimPmf).not.toHaveBeenCalled();
  });

  it('shows nothing when the server says the person is not eligible', async () => {
    api.claimPmf.mockResolvedValue(false);
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 1000);
    expect(api.claimPmf).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends the chosen answer with the trimmed comments', async () => {
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 1000);
    fireEvent.click(screen.getByRole('radio', { name: 'prompt.answers.very_disappointed' }));
    fireEvent.change(screen.getByLabelText('prompt.benefit'), { target: { value: '  saves me calls  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'prompt.send' })); });
    expect(api.respondPmf).toHaveBeenCalledWith('very_disappointed', 'saves me calls', '');
    expect(screen.getByRole('status')).toHaveTextContent('prompt.thanks');
  });

  it('"don\'t ask again" is forwarded to the server and closes the prompt', async () => {
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 1000);
    fireEvent.click(screen.getByRole('button', { name: 'prompt.never' }));
    expect(api.dismissPmf).toHaveBeenCalledWith('never', 30);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape dismisses', async () => {
    mount();
    await wait(PMF_PROMPT_DELAY_MS + 1000);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(api.dismissPmf).toHaveBeenCalledWith('dismissed', 30);
  });
});
