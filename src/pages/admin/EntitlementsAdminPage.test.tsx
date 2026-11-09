import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
const api = vi.hoisted(() => ({ listAccountEntitlements: vi.fn(), listEntitlementAudit: vi.fn(), setEntitlement: vi.fn() }));
vi.mock('@/lib/entitlementsApi', () => api);
const searchTenants = vi.hoisted(() => vi.fn());
vi.mock('@/lib/featureFlagsApi', () => ({ searchTenants }));

import { EntitlementsAdminPage } from './EntitlementsAdminPage';

const hit = { id: 't1', email: 'owner@acme.test', company_name: 'Acme HVAC', full_name: null, plan: 'professional' };
const rowOf = (module_id: string, over: Record<string, unknown> = {}) => ({
  module_id, state: 'on', source: 'manual', expires_at: null, active: true, reason: 'Pilot agreement', updated_at: '2030-01-01T10:00:00Z', updated_by_email: 'staff@vireek.test', ...over,
});

async function pickAcme() {
  render(<EntitlementsAdminPage />);
  fireEvent.change(screen.getByLabelText(/Email, company or name/i), { target: { value: 'acme' } });
  fireEvent.click(await screen.findByText('Acme HVAC'));
  await screen.findByText(/Modules · Acme HVAC/);
}

beforeEach(() => {
  searchTenants.mockResolvedValue([hit]);
  api.listAccountEntitlements.mockResolvedValue([rowOf('core', { source: 'plan' }), rowOf('pay')]);
  api.listEntitlementAudit.mockResolvedValue([]);
  api.setEntitlement.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntitlementsAdminPage', () => {
  it('asks for an account first (empty state) and does not load anything', () => {
    render(<EntitlementsAdminPage />);
    expect(screen.getByText('Pick an account')).toBeTruthy();
    expect(api.listAccountEntitlements).not.toHaveBeenCalled();
  });

  it('shows "no results" when the search finds nothing', async () => {
    searchTenants.mockResolvedValue([]);
    render(<EntitlementsAdminPage />);
    fireEvent.change(screen.getByLabelText(/Email, company or name/i), { target: { value: 'zzz' } });
    expect(await screen.findByText('No matching accounts.')).toBeTruthy();
  });

  it('loads the selected account\'s modules and shows default-off modules as Off', async () => {
    await pickAcme();
    const ai = screen.getByText('AI').closest('li') as HTMLElement;
    expect(within(ai).getByText('Off')).toBeTruthy();
    const pay = screen.getByText('Pay').closest('li') as HTMLElement;
    expect(within(pay).getByText('On')).toBeTruthy();
    expect(api.listAccountEntitlements).toHaveBeenCalledWith('t1');
  });

  it('shows an error state with retry when loading modules fails', async () => {
    api.listAccountEntitlements.mockRejectedValueOnce(new Error('Staff access is required for this action.'));
    await pickAcme().catch(() => undefined);
    expect(await screen.findByText('Staff access is required for this action.')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(api.listAccountEntitlements).toHaveBeenCalledTimes(2));
  });

  it('blocks a save without a reason and never calls the API', async () => {
    await pickAcme();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Give a reason/)).toBeTruthy();
    expect(api.setEntitlement).not.toHaveBeenCalled();
  });

  it('grants a module with a reason and refreshes the list', async () => {
    await pickAcme();
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'ai' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Signed upgrade' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setEntitlement).toHaveBeenCalledWith('t1', { module_id: 'ai', state: 'on', source: 'manual', expires_at: null, reason: 'Signed upgrade' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('AI set to on.', 'success'));
    expect(api.listAccountEntitlements).toHaveBeenCalledTimes(2);
  });

  it('revoke asks for confirmation and then saves state off', async () => {
    await pickAcme();
    const pay = screen.getByText('Pay').closest('li') as HTMLElement;
    fireEvent.click(within(pay).getByRole('button', { name: 'Revoke' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Contract ended' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Turn off Pay?')).toBeTruthy();
    expect(api.setEntitlement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.setEntitlement).toHaveBeenCalledWith('t1', expect.objectContaining({ module_id: 'pay', state: 'off', reason: 'Contract ended' })));
  });

  it('shows a toast and keeps the form when the server rejects the change', async () => {
    api.setEntitlement.mockRejectedValueOnce(new Error('A reason of 5 to 300 characters is required'));
    await pickAcme();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Signed upgrade' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('A reason of 5 to 300 characters is required', 'error'));
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe('Signed upgrade');
  });
});
