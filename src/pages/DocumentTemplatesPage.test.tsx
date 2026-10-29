import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultDesign, type DocumentTemplate } from '@/lib/documentTemplates';

const toast = vi.fn();
const auth = {
  profile: { id: 'owner-1', email: 'o@x.com', phone: '555-0100', company_name: 'Acme HVAC', role: 'owner' } as unknown,
  profileLoading: false,
  isOwner: true,
  permissions: { can_edit_business_profile: true, can_view_billing: true } as Record<string, boolean>,
  teamMember: null as { account_owner_id: string } | null,
  user: { id: 'owner-1', email: 'o@x.com' },
};

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) } },
}));
vi.mock('@/lib/branding', () => ({
  fetchBrandSettings: vi.fn().mockResolvedValue(null),
  logoPublicUrl: (p: string | null) => (p ? `https://cdn.test/${p}` : null),
}));
vi.mock('@/lib/documentTemplatePdf', () => ({
  downloadTemplatePdf: vi.fn().mockResolvedValue(undefined),
  loadLogoDataUrl: vi.fn().mockResolvedValue(null),
}));

const fetchDocumentTemplates = vi.fn();
const createDocumentTemplate = vi.fn();
const updateDocumentTemplate = vi.fn();
const setDocumentTemplateStatus = vi.fn();
const setDocumentTemplateDefault = vi.fn();
vi.mock('@/lib/documentTemplatesApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/documentTemplatesApi')>('@/lib/documentTemplatesApi');
  return {
    ...actual,
    fetchDocumentTemplates: (...a: unknown[]) => fetchDocumentTemplates(...a),
    createDocumentTemplate: (...a: unknown[]) => createDocumentTemplate(...a),
    updateDocumentTemplate: (...a: unknown[]) => updateDocumentTemplate(...a),
    setDocumentTemplateStatus: (...a: unknown[]) => setDocumentTemplateStatus(...a),
    setDocumentTemplateDefault: (...a: unknown[]) => setDocumentTemplateDefault(...a),
  };
});

import { DocumentTemplatesPage } from './DocumentTemplatesPage';

const tpl = (over: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 't1',
  user_id: 'owner-1',
  name: 'Classic invoice',
  doc_type: 'invoice',
  design: defaultDesign('invoice'),
  is_default: false,
  status: 'active',
  revision: 1,
  created_by: 'owner-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

const renderPage = (url = '/dashboard/document-templates') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <DocumentTemplatesPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.isOwner = true;
  auth.teamMember = null;
  auth.permissions = { can_edit_business_profile: true, can_view_billing: true };
  fetchDocumentTemplates.mockResolvedValue([]);
});

describe('DocumentTemplatesPage — states', () => {
  it('shows a skeleton while loading, then the empty state with a create action', async () => {
    let resolve: (v: DocumentTemplate[]) => void = () => undefined;
    fetchDocumentTemplates.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    expect(screen.queryByText('No templates yet')).toBeNull();
    resolve([]);
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create a template/i })).toBeInTheDocument();
  });

  it('shows a retryable error state when loading fails', async () => {
    fetchDocumentTemplates.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText("Couldn't load your templates")).toBeInTheDocument();
    fetchDocumentTemplates.mockResolvedValueOnce([tpl()]);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Classic invoice')).toBeInTheDocument();
  });

  it('blocks people without billing or business-profile access', () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-1' };
    auth.permissions = { can_edit_business_profile: false, can_view_billing: false };
    renderPage();
    expect(screen.getByText('Document templates are restricted')).toBeInTheDocument();
    expect(fetchDocumentTemplates).not.toHaveBeenCalled();
  });

  it('lists templates with a default badge and hides write actions for read-only members', async () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-1' };
    auth.permissions = { can_edit_business_profile: false, can_view_billing: true };
    fetchDocumentTemplates.mockResolvedValue([tpl({ is_default: true }), tpl({ id: 't2', name: 'Quote A', doc_type: 'quote' })]);
    renderPage();
    expect(await screen.findByText('Classic invoice')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new template/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /duplicate/i })).toBeNull();
  });

  it('filters by search text and shows a clear-filters empty state', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl(), tpl({ id: 't2', name: 'Quote A', doc_type: 'quote' })]);
    renderPage();
    await screen.findByText('Classic invoice');
    fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing matches')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Classic invoice')).toBeInTheDocument();
  });
});

describe('DocumentTemplatesPage — actions', () => {
  it('creates a template and opens the editor', async () => {
    createDocumentTemplate.mockImplementation(async (_o: string, i: { name: string; docType: 'quote' }) =>
      tpl({ id: 'new1', name: i.name, doc_type: i.docType, design: defaultDesign('quote') }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /create a template/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create and design/i }));
    await waitFor(() => expect(createDocumentTemplate).toHaveBeenCalledTimes(1));
    expect(createDocumentTemplate.mock.calls[0][0]).toBe('owner-1');
    expect(createDocumentTemplate.mock.calls[0][1].docType).toBe('quote');
    expect(await screen.findByLabelText('Template name')).toHaveValue('Quote — Classic');
  });

  it('makes a template the default through the RPC', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    setDocumentTemplateDefault.mockResolvedValue(tpl({ is_default: true }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /make classic invoice the default/i }));
    await waitFor(() => expect(setDocumentTemplateDefault).toHaveBeenCalledWith('t1', true));
    expect(await screen.findByText('Default')).toBeInTheDocument();
  });

  it('archives a template', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    setDocumentTemplateStatus.mockResolvedValue(tpl({ status: 'archived' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /archive classic invoice/i }));
    await waitFor(() => expect(setDocumentTemplateStatus).toHaveBeenCalledWith('t1', 'owner-1', '2026-01-02T00:00:00Z', 'archived'));
  });
});

describe('DocumentTemplatesPage — editor', () => {
  it('keeps Save disabled until something changes, then saves with the concurrency token', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    updateDocumentTemplate.mockResolvedValue(tpl({ name: 'Renamed', updated_at: '2026-01-03T00:00:00Z' }));
    renderPage('/dashboard/document-templates?template=t1');
    const nameInput = await screen.findByLabelText('Template name');
    const save = screen.getByRole('button', { name: /^saved$/i });
    expect(save).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    const saveNow = await screen.findByRole('button', { name: /save changes/i });
    expect(saveNow).toBeEnabled();
    fireEvent.click(saveNow);
    await waitFor(() => expect(updateDocumentTemplate).toHaveBeenCalledTimes(1));
    const args = updateDocumentTemplate.mock.calls[0];
    expect(args[0]).toBe('t1');
    expect(args[2]).toBe('2026-01-02T00:00:00Z');
    expect(args[3]).toBe('invoice');
    expect(args[4].name).toBe('Renamed');
  });

  it('rejects an empty name without calling the API', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    renderPage('/dashboard/document-templates?template=t1');
    const nameInput = await screen.findByLabelText('Template name');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    expect(updateDocumentTemplate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Give the template a name.', 'error');
  });

  it('shows the live preview and warns about characters the PDF fonts cannot draw', async () => {
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    renderPage('/dashboard/document-templates?template=t1');
    expect(await screen.findByTestId('document-preview')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'فاکتور' } });
    expect(await screen.findByText(/only support Latin characters/i)).toBeInTheDocument();
  });

  it('shows a friendly message for an unknown template id', async () => {
    renderPage('/dashboard/document-templates?template=missing');
    expect(await screen.findByText('Template unavailable')).toBeInTheDocument();
  });

  it('is read-only for members who cannot edit', async () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-1' };
    auth.permissions = { can_edit_business_profile: false, can_view_billing: true };
    fetchDocumentTemplates.mockResolvedValue([tpl()]);
    renderPage('/dashboard/document-templates?template=t1');
    expect(await screen.findByLabelText('Template name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.getByText(/you can view this template/i)).toBeInTheDocument();
  });
});
