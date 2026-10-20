import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CallDispositionPanel, type DispositionCall } from './CallDispositionPanel';

const api = vi.hoisted(() => ({
  fetchDisposition: vi.fn(),
  fetchFollowUp: vi.fn(),
  saveDisposition: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/callDispositionApi', () => api);
vi.mock('@/lib/tasksApi', () => ({
  fetchAssignees: () => Promise.resolve([{ userId: 'u1', name: 'Owner', role: 'you' }]),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'o@x.com' }, profile: { id: 'u1', full_name: 'Owner' }, isOwner: true, permissions: {} }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

const CALL: DispositionCall = {
  id: 'c1',
  caller_name: 'Dana Whitfield',
  caller_phone: '+15551230000',
  status: 'new_lead',
  booking_outcome: null,
  is_voicemail: false,
  duration_seconds: 120,
  transcript: 'Caller: hi',
  summary: 'Asked how much a water heater costs.',
  intent: null,
};

const ROW = {
  id: 'd1',
  user_id: 'u1',
  call_id: 'c1',
  outcome: 'quoted',
  source: 'staff',
  ai_outcome: null,
  ai_confidence: null,
  note: 'wants Friday',
  follow_up_task_id: 't1',
  set_by: 'u1',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function renderPanel(props: Partial<{ call: DispositionCall; canEdit: boolean }> = {}) {
  return render(
    <MemoryRouter>
      <CallDispositionPanel call={props.call ?? CALL} accountOwnerId="u1" canEdit={props.canEdit ?? true} />
    </MemoryRouter>,
  );
}

const radio = (name: string) => screen.findByRole('radio', { name });

describe('CallDispositionPanel', () => {
  beforeEach(() => {
    api.fetchDisposition.mockReset().mockResolvedValue(null);
    api.fetchFollowUp.mockReset().mockResolvedValue(null);
    api.saveDisposition.mockReset().mockResolvedValue({ disposition: ROW, taskCreated: true });
    toast.mockReset();
  });

  it('shows a skeleton first, then the outcome picker with all seven outcomes', async () => {
    renderPanel();
    expect(screen.getByLabelText('Loading call outcome')).toBeTruthy();
    await radio('Booked');
    expect(screen.getAllByRole('radio')).toHaveLength(7);
  });

  it('offers a suggestion from call data and applies it with one tap', async () => {
    renderPanel();
    await screen.findByTestId('disposition-suggestion');
    fireEvent.click(screen.getByRole('button', { name: /use suggestion/i }));
    expect((await radio('Quoted')).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('follow-up-section')).toBeTruthy();
  });

  it('blocks saving a required outcome when the follow-up title is empty', async () => {
    renderPanel();
    fireEvent.click(await radio('Quoted'));
    fireEvent.change(screen.getByLabelText(/task title/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));
    expect(await screen.findByText('Give the follow-up task a title.')).toBeTruthy();
    expect(api.saveDisposition).not.toHaveBeenCalled();
  });

  it('saves spam without any follow-up task', async () => {
    renderPanel();
    fireEvent.click(await radio('Spam'));
    expect(screen.queryByTestId('follow-up-section')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));
    await waitFor(() => expect(api.saveDisposition).toHaveBeenCalled());
    expect(api.saveDisposition).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1', outcome: 'spam', followUp: null }));
  });

  it('sends the prefilled follow-up for a required outcome', async () => {
    renderPanel();
    fireEvent.click(await radio('Quoted'));
    await screen.findByRole('option', { name: /Owner/ });
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));
    await waitFor(() => expect(api.saveDisposition).toHaveBeenCalled());
    expect(api.saveDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'quoted',
        followUp: expect.objectContaining({
          title: 'Follow up on quote with Dana Whitfield',
          priority: 'high',
          assigned_to: 'u1',
          assigned_to_name: 'Owner',
        }),
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Outcome saved and follow-up task created.', 'success'));
  });

  it('makes the follow-up optional for booked', async () => {
    renderPanel();
    fireEvent.click(await radio('Booked'));
    const toggle = screen.getByLabelText(/create a follow-up task/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByLabelText(/task title/i)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText(/task title/i)).toBeTruthy();
  });

  it('shows the saved outcome with its linked follow-up and nothing left to save', async () => {
    api.fetchDisposition.mockResolvedValue(ROW);
    api.fetchFollowUp.mockResolvedValue({ id: 't1', title: 'Follow up on quote with Dana', status: 'todo', due_at: null, assigned_to_name: 'Owner' });
    renderPanel();
    const status = await screen.findByTestId('disposition-status');
    expect(within(status).getByText('Quoted')).toBeTruthy();
    expect(within(status).getByRole('link', { name: 'Follow up on quote with Dana' })).toBeTruthy();
    expect(within(status).getByText('wants Friday')).toBeTruthy();
    expect((screen.getByRole('button', { name: /update outcome/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks staff to confirm an outcome the AI picked', async () => {
    api.fetchDisposition.mockResolvedValue({ ...ROW, outcome: 'booked', source: 'ai', ai_outcome: 'booked', ai_confidence: 0.9, follow_up_task_id: null, note: null });
    renderPanel();
    expect(await screen.findByText(/Set by AI · 90% confident/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: /confirm outcome/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('is read-only without edit access', async () => {
    renderPanel({ canEdit: false });
    expect(await screen.findByText('Outcome not recorded for this call.')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button', { name: /save outcome/i })).toBeNull();
  });

  it('shows a readable error when the server rejects the save', async () => {
    api.saveDisposition.mockRejectedValue(new Error('follow_up_required'));
    renderPanel();
    fireEvent.click(await radio('Quoted'));
    fireEvent.click(screen.getByRole('button', { name: /save outcome/i }));
    expect(await screen.findByText(/needs a follow-up task/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /save outcome/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('recovers from a load failure with Try again', async () => {
    api.fetchDisposition.mockRejectedValueOnce(new Error('network')).mockResolvedValue(null);
    renderPanel();
    expect(await screen.findByText('Could not load the call outcome.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await radio('Booked');
  });
});
