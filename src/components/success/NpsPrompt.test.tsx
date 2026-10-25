import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  fetchNpsDue: vi.fn(),
  submitNps: vi.fn(),
  snoozeNpsPrompt: vi.fn(),
}));
vi.mock('@/lib/successToolsApi', () => api);

import { NPS_PROMPT_DELAY_MS, NpsPrompt, resetNpsPromptThrottleForTests } from './NpsPrompt';

async function mount() {
  render(<NpsPrompt />);
}
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetNpsPromptThrottleForTests();
  api.snoozeNpsPrompt.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NpsPrompt', () => {
  it('stays hidden until the delay passes and the server says it is due', async () => {
    api.fetchNpsDue.mockResolvedValue(true);
    await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await wait(NPS_PROMPT_DELAY_MS - 1000);
    expect(api.fetchNpsDue).not.toHaveBeenCalled();
    await wait(1500);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('never shows when the account is not eligible', async () => {
    api.fetchNpsDue.mockResolvedValue(false);
    await mount();
    await wait(NPS_PROMPT_DELAY_MS + 100);
    expect(api.fetchNpsDue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('submits the chosen score with the comment, then thanks and closes', async () => {
    api.fetchNpsDue.mockResolvedValue(true);
    api.submitNps.mockResolvedValue({ ok: true, category: 'promoter' });
    await mount();
    await wait(NPS_PROMPT_DELAY_MS + 100);

    const send = screen.getByRole('button', { name: 'Send feedback' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText('9 out of 10'));
    expect(send).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Love the AI receptionist' } });
    await act(async () => {
      fireEvent.click(send);
    });

    expect(api.submitNps).toHaveBeenCalledWith(9, 'Love the AI receptionist', 'prompt');
    expect(screen.getByRole('status')).toHaveTextContent(/thank you/i);
    await wait(4100);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an error and keeps the answer when saving fails', async () => {
    api.fetchNpsDue.mockResolvedValue(true);
    api.submitNps.mockRejectedValue(new Error('boom'));
    await mount();
    await wait(NPS_PROMPT_DELAY_MS + 100);
    fireEvent.click(screen.getByLabelText('3 out of 10'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn’t save/i);
    expect(screen.getByLabelText('3 out of 10')).toBeChecked();
  });

  it('snoozes on "Not now"', async () => {
    api.fetchNpsDue.mockResolvedValue(true);
    await mount();
    await wait(NPS_PROMPT_DELAY_MS + 100);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    });
    expect(api.snoozeNpsPrompt).toHaveBeenCalledWith(14);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('snoozes on Escape', async () => {
    api.fetchNpsDue.mockResolvedValue(true);
    await mount();
    await wait(NPS_PROMPT_DELAY_MS + 100);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(api.snoozeNpsPrompt).toHaveBeenCalledWith(14);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
