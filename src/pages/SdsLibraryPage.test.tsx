import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SdsDocument } from '@/lib/sds';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchSdsList: vi.fn(),
  setSdsArchived: vi.fn(),
  openSdsFile: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/sds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sds')>();
  return { ...actual, fetchSdsList: mocks.fetchSdsList, setSdsArchived: mocks.setSdsArchived, openSdsFile: mocks.openSdsFile };
});

import { SdsLibraryPage } from './SdsLibraryPage';

function doc(over: Partial<SdsDocument>): SdsDocument {
  return {
    id: 'd1',
    product_name: 'R-410A refrigerant',
    manufacturer: 'Honeywell',
    product_code: null,
    cas_numbers: ['75-10-5', '354-33-6'],
    signal_word: 'warning',
    hazard_classes: ['compressed_gas'],
    hazard_statements: null,
    first_aid: null,
    ppe: null,
    storage_notes: null,
    location: 'Van 3',
    revision_date: null,
    review_due_date: '2099-01-01',
    status: 'active',
    file_path: 'owner-1/x-r410a.pdf',
    file_name: 'r410a.pdf',
    file_mime: 'application/pdf',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const DOCS = [
  doc({}),
  doc({ id: 'd2', product_name: 'Coil cleaner', manufacturer: 'NuCalgon', cas_numbers: ['1310-73-2'], signal_word: 'danger', hazard_classes: ['corrosive'], location: 'Shop', review_due_date: '2020-01-01', file_path: null }),
  doc({ id: 'd3', product_name: 'Old flux', status: 'archived' }),
];

function setAuth(canManage = true) {
  mocks.auth = {
    isOwner: canManage,
    profile: { id: 'owner-1' },
    teamMember: canManage ? null : { account_owner_id: 'owner-1' },
    permissions: { can_manage_team: canManage },
  };
}

function renderPage(url = '/safety/sds') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SdsLibraryPage />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  setAuth(true);
  mocks.fetchSdsList.mockReset();
  mocks.setSdsArchived.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

describe('SdsLibraryPage', () => {
  it('shows a loading state, then active sheets sorted by name with stats', async () => {
    mocks.fetchSdsList.mockResolvedValue(DOCS);
    renderPage();
    expect(screen.getByRole('status', { name: /loading safety data sheets/i })).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: /safety data sheets/i });
    const names = within(list).getAllByRole('button', { name: /^View /i }).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['View Coil cleaner', 'View R-410A refrigerant']);
    expect(screen.queryByText('Old flux')).not.toBeInTheDocument();
    expect(screen.getByText('Active sheets')).toBeInTheDocument();
    expect(mocks.fetchSdsList).toHaveBeenCalledWith('owner-1');
  });

  it('finds a product by CAS number and offers to clear when nothing matches', async () => {
    mocks.fetchSdsList.mockResolvedValue(DOCS);
    renderPage();
    const search = await screen.findByRole('searchbox', { name: /search safety data sheets/i });

    fireEvent.change(search, { target: { value: '1310-73-2' } });
    expect(screen.getByRole('button', { name: 'View Coil cleaner' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View R-410A refrigerant' })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz-nothing' } });
    expect(screen.getByText('No sheets match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'View R-410A refrigerant' })).toBeInTheDocument();
  });

  it('starts with the ?q= search from a link', async () => {
    mocks.fetchSdsList.mockResolvedValue(DOCS);
    renderPage('/safety/sds?q=nucalgon');
    expect(await screen.findByRole('button', { name: 'View Coil cleaner' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View R-410A refrigerant' })).not.toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    mocks.fetchSdsList.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(DOCS);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: 'View R-410A refrigerant' })).toBeInTheDocument();
    expect(mocks.fetchSdsList).toHaveBeenCalledTimes(2);
  });

  it('shows an empty library with an add action for managers', async () => {
    mocks.fetchSdsList.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No safety data sheets yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add your first sheet/i }));
    expect(await screen.findByRole('dialog', { name: /add safety data sheet/i })).toBeInTheDocument();
  });

  it('hides management actions from people without permission', async () => {
    setAuth(false);
    mocks.fetchSdsList.mockResolvedValue(DOCS);
    renderPage();
    await screen.findByRole('button', { name: 'View Coil cleaner' });
    expect(screen.queryByRole('button', { name: /add sheet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit /i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archive /i })).not.toBeInTheDocument();
  });

  it('restores an archived sheet', async () => {
    mocks.fetchSdsList.mockResolvedValue(DOCS);
    renderPage();
    await screen.findByRole('button', { name: 'View Coil cleaner' });
    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old flux' }));
    await waitFor(() => expect(mocks.setSdsArchived).toHaveBeenCalledWith('owner-1', 'd3', false));
    expect(mocks.toast).toHaveBeenCalledWith('Sheet restored.', 'success');
  });
});
