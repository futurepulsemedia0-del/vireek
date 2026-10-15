import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toast = vi.fn();
const auth = {
  profile: { id: 'owner-1', email: 'o@x.com', company_name: 'Acme HVAC', role: 'owner' } as unknown,
  profileLoading: false,
  isOwner: true,
  permissions: { can_edit_business_profile: true } as Record<string, boolean>,
  teamMember: null as { account_owner_id: string } | null,
  user: { id: 'owner-1', email: 'o@x.com' },
};

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  },
}));

const fetchBrandSettings = vi.fn();
const saveBrandSettings = vi.fn();
vi.mock('@/lib/branding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/branding')>('@/lib/branding');
  return {
    ...actual,
    fetchBrandSettings: (...a: unknown[]) => fetchBrandSettings(...a),
    saveBrandSettings: (...a: unknown[]) => saveBrandSettings(...a),
    logBrandingChange: vi.fn(),
  };
});

import { BrandingSettingsPage } from './BrandingSettingsPage';

const renderPage = () =>
  render(
    <MemoryRouter>
      <BrandingSettingsPage />
    </MemoryRouter>,
  );

const row = (over = {}) => ({
  user_id: 'owner-1',
  logo_path: null,
  primary_color: '#2563EB',
  accent_color: '#0EA5E9',
  email_sender_name: null,
  email_reply_to: null,
  email_footer: null,
  sms_sender_label: null,
  portal_theme: 'auto',
  portal_welcome_title: null,
  portal_welcome_message: null,
  portal_show_powered_by: true,
  custom_domain: null,
  domain_status: 'unconfigured',
  domain_verification_token: null,
  domain_verified_at: null,
  domain_last_checked_at: null,
  domain_error: null,
  updated_at: '2027-01-01T00:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.isOwner = true;
  auth.profileLoading = false;
  auth.permissions = { can_edit_business_profile: true };
  auth.teamMember = null;
});

describe('BrandingSettingsPage', () => {
  it('blocks team members without the permission', () => {
    auth.isOwner = false;
    auth.permissions = { can_edit_business_profile: false };
    auth.teamMember = { account_owner_id: 'owner-1' };
    renderPage();
    expect(screen.getByText(/don.t have access to branding/i)).toBeInTheDocument();
    expect(fetchBrandSettings).not.toHaveBeenCalled();
  });

  it('scopes reads to the ACCOUNT OWNER id for team members', async () => {
    auth.isOwner = false;
    auth.permissions = { can_edit_business_profile: true };
    auth.teamMember = { account_owner_id: 'owner-9' };
    auth.profile = { id: 'member-1', email: 'm@x.com', company_name: 'Acme', role: 'member' };
    fetchBrandSettings.mockResolvedValue(null);
    renderPage();
    await waitFor(() => expect(fetchBrandSettings).toHaveBeenCalledWith('owner-9'));
    auth.profile = { id: 'owner-1', email: 'o@x.com', company_name: 'Acme HVAC', role: 'owner' };
  });

  it('shows an error state with retry, then recovers', async () => {
    fetchBrandSettings.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(row());
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Brand colors')).toBeInTheDocument();
  });

  it('shows the empty/default hint when nothing is saved yet and keeps Save disabled until edited', async () => {
    fetchBrandSettings.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText(/haven.t customized anything/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('saves edits against the owner id and resets the dirty state', async () => {
    fetchBrandSettings.mockResolvedValue(row());
    saveBrandSettings.mockResolvedValue(row({ email_sender_name: 'Acme Service' }));
    renderPage();
    const input = await screen.findByLabelText('Sender name');
    fireEvent.change(input, { target: { value: 'Acme Service' } });
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(saveBrandSettings).toHaveBeenCalledTimes(1));
    expect(saveBrandSettings.mock.calls[0][0]).toBe('owner-1');
    expect(saveBrandSettings.mock.calls[0][1]).toMatchObject({ email_sender_name: 'Acme Service' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Branding saved.', 'success'));
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('blocks saving invalid input and shows the field error', async () => {
    fetchBrandSettings.mockResolvedValue(row());
    renderPage();
    fireEvent.change(await screen.findByLabelText('Reply-to email'), { target: { value: 'not-an-email' } });
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('discard restores the saved values', async () => {
    fetchBrandSettings.mockResolvedValue(row());
    renderPage();
    const input = (await screen.findByLabelText('Sender name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Temp' } });
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(input.value).toBe('');
  });

  it('asks to save before showing DNS records for a new domain, and shows them once saved', async () => {
    fetchBrandSettings.mockResolvedValue(row({ custom_domain: 'portal.acme.com', domain_status: 'pending', domain_verification_token: 'tok123' }));
    renderPage();
    expect(await screen.findByText('vireek-verify=tok123')).toBeInTheDocument();
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'other.acme.com' } });
    expect(screen.getByText(/save your changes to generate the dns records/i)).toBeInTheDocument();
  });
});
