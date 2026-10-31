import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const invoke = vi.fn();
const toast = vi.fn();
const tables: Record<string, { data: unknown[]; error: { message: string } | null }> = {};
const auth = { isOwner: true, profile: { id: 'owner-1' }, teamMember: null, permissions: { can_export_data: true }, loading: false, profileLoading: false };

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(tables[table] ?? { data: [], error: null }).then(res, rej);
      return q;
    },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/realtime', () => ({ useRealtimeSubscription: () => undefined }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { BiConnectorsPage } from './BiConnectorsPage';

const TOKEN = {
  id: 't1', name: 'Power BI finance', token_hint: 'vbi_AbCd…', datasets: ['jobs'], pii_mode: 'hashed', rate_limit_per_minute: 60,
  expires_at: null, status: 'active', last_used_at: null, created_at: '2027-01-01T00:00:00Z', revoked_at: null,
};

const renderPage = (url = '/dashboard/bi-connectors') => render(<MemoryRouter initialEntries={[url]}><BiConnectorsPage /></MemoryRouter>);

beforeEach(() => {
  invoke.mockReset();
  toast.mockReset();
  for (const k of Object.keys(tables)) delete tables[k];
  auth.isOwner = true;
  auth.permissions = { can_export_data: true };
});

describe('BiConnectorsPage', () => {
  it('blocks people without the export permission', async () => {
    auth.isOwner = false;
    auth.permissions = { can_export_data: false };
    renderPage();
    expect(await screen.findByText('Permission required')).toBeInTheDocument();
    expect(screen.queryByText('Live read-only access')).not.toBeInTheDocument();
  });

  it('shows the empty state, then a token list', async () => {
    renderPage();
    expect(await screen.findByText('No tokens yet')).toBeInTheDocument();
  });

  it('lists tokens with their scope and never shows a secret', async () => {
    tables.bi_access_tokens = { data: [TOKEN], error: null };
    renderPage();
    expect(await screen.findByText('Power BI finance')).toBeInTheDocument();
    expect(screen.getByText('vbi_AbCd…')).toBeInTheDocument();
    expect(screen.getByText(/Entity sets: Jobs/)).toBeInTheDocument();
  });

  it('shows a retryable error when loading fails', async () => {
    tables.bi_access_tokens = { data: [], error: { message: 'boom' } };
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('creates a token, reveals the secret once and sends exactly what was chosen', async () => {
    invoke.mockResolvedValue({ data: { token: TOKEN, secret: 'vbi_SECRETSECRETSECRETSECRETSECRETSECRETSECRE' }, error: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /create a token/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Tableau ops' } });
    fireEvent.click(screen.getByRole('button', { name: /^create token$/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke.mock.calls[0][0]).toBe('bi-admin');
    expect(invoke.mock.calls[0][1].body).toMatchObject({ action: 'create_token', name: 'Tableau ops', pii_mode: 'hashed', rate_limit_per_minute: 60, expires_in_days: 180 });
    expect(await screen.findByText(/copy your token now/i)).toBeInTheDocument();
    expect(screen.getByText('vbi_SECRETSECRETSECRETSECRETSECRETSECRETSECRE')).toBeInTheDocument();
  });

  it('validates before calling the server', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /create a token/i }));
    fireEvent.click(screen.getByRole('button', { name: /^create token$/i }));
    expect(await screen.findByText(/give the token a name/i)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows a readable error when creating a token fails', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('network') });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /create a token/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: /^create token$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the token.');
  });

  it('exports tab: empty state and S3 target creation payload', async () => {
    invoke.mockResolvedValue({ data: { target: { id: 'x' } }, error: null });
    renderPage('/dashboard/bi-connectors?tab=exports');
    expect(await screen.findByText('No export targets yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add an s3 bucket/i }));
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Lake' } });
    fireEvent.change(screen.getByLabelText(/^bucket/i), { target: { value: 'my-bucket' } });
    fireEvent.change(screen.getByLabelText(/^access key id/i), { target: { value: 'AKIAIOSFODNN7EXAMPLE' } });
    fireEvent.change(screen.getByLabelText(/^secret access key/i), { target: { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } });
    fireEvent.click(screen.getByRole('button', { name: /create target/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0][1].body;
    expect(invoke.mock.calls[0][0]).toBe('bi-admin');
    expect(body).toMatchObject({ action: 'save_export_target', kind: 's3', name: 'Lake', interval_minutes: 1440, config: { bucket: 'my-bucket', region: 'us-east-1', sse: true }, settings: { pii_mode: 'hashed', format: 'csv', mode: 'incremental' } });
    expect(body.credentials).toMatchObject({ access_key_id: 'AKIAIOSFODNN7EXAMPLE' });
  });

  it('guides tab renders the OData URL', async () => {
    renderPage('/dashboard/bi-connectors?tab=guides');
    expect(await screen.findByText(/OData feed/i)).toBeInTheDocument();
    expect(screen.getByText(/bi-gateway\/odata\//)).toBeInTheDocument();
  });
});
