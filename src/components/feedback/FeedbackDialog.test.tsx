import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  submitFeedback: vi.fn(), uploadScreenshot: vi.fn(), getFeedbackPrivacy: vi.fn(),
}));
vi.mock('@/lib/feedback/api', () => api);
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/feedback/FeedbackScreenshot', () => ({ FeedbackScreenshot: () => <div data-testid="shot" /> }));

import { FeedbackDialog } from './FeedbackDialog';
import { openFeedback } from '@/lib/feedback/events';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/jobs/123456?x=1']}>
      <button>opener</button>
      <FeedbackDialog />
    </MemoryRouter>,
  );
}
const open = async () => { screen.getByText('opener').focus(); await act(async () => openFeedback('bug')); };

beforeEach(() => {
  vi.clearAllMocks();
  api.getFeedbackPrivacy.mockResolvedValue({ anonymous_default: false, never_ask: false, snoozed_until: null });
  api.submitFeedback.mockResolvedValue({ ok: true, trackingCode: 'FB-ABCD2345' });
});
afterEach(() => cleanup());

describe('FeedbackDialog accessibility', () => {
  it('is hidden until opened, then is a labelled modal dialog', async () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await open();
    const d = screen.getByRole('dialog');
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('Send feedback');
    expect(d).toHaveAccessibleDescription(/read every message/i);
  });

  it('moves focus inside, traps Tab, closes on Escape and returns focus to the opener', async () => {
    mount();
    await open();
    const d = screen.getByRole('dialog');
    expect(d.contains(document.activeElement)).toBe(true);
    const focusables = Array.from(d.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href]'));
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    focusables[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByText('opener'));
  });

  it('exposes the category as a labelled radio group and every field has an accessible name', async () => {
    mount();
    await open();
    expect(screen.getByRole('group', { name: /what kind of feedback/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /something’s broken/i })).toBeChecked();
    expect(screen.getByRole('textbox', { name: /your feedback/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /include technical details/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /close feedback/i })).toBeInTheDocument();
    for (const el of screen.getAllByRole('button')) expect(el).toHaveAccessibleName();
  });

  it('announces validation errors and does not submit an empty message', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 3 characters/i);
    expect(api.submitFeedback).not.toHaveBeenCalled();
  });
});

describe('FeedbackDialog behaviour', () => {
  it('redacts PII and sanitises the route before sending, and shows a tracking ID', async () => {
    mount();
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: /your feedback/i }), { target: { value: 'Crash. Call me 555-123-4567 or jo@acme.com' } });
    expect(screen.getByText(/look private and will be hidden/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^send feedback$/i }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalled());
    const arg = api.submitFeedback.mock.calls[0][0];
    expect(arg.message).toBe('Crash. Call me [phone] or [email]');
    expect(arg.context.route).toBe('/dashboard/jobs/:id');
    expect(arg.category).toBe('bug');
    expect(await screen.findByRole('status')).toHaveTextContent('FB-ABCD2345');
  });

  it('sends no context when the person unticks technical details, and cannot ask for contact while anonymous', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: /include technical details/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /keep me anonymous/i }));
    expect(screen.getByRole('checkbox', { name: /ok to email me/i })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /your feedback/i }), { target: { value: 'Please add dark mode' } });
    fireEvent.click(screen.getByRole('button', { name: /^send feedback$/i }));
    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalled());
    const arg = api.submitFeedback.mock.calls[0][0];
    expect(arg.context).toEqual({});
    expect(arg.anonymous).toBe(true);
    expect(arg.contactOk).toBe(false);
  });

  it('shows a friendly message when rate limited', async () => {
    api.submitFeedback.mockResolvedValue({ ok: false, reason: 'rate_limited' });
    mount();
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: /your feedback/i }), { target: { value: 'Another idea here' } });
    fireEvent.click(screen.getByRole('button', { name: /^send feedback$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again a little later/i);
  });
});
