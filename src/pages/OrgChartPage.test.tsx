import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/orgChartApi', () => ({ getOrgOverview: vi.fn(), getOrgHistory: vi.fn(), setOrgPosition: vi.fn() }));

import { getOrgHistory, getOrgOverview, setOrgPosition } from '@/lib/orgChartApi';
import { OrgChartPage } from './OrgChartPage';
import type { OrgMember, OrgOverview } from '@/lib/orgChart';

const overviewMock = getOrgOverview as unknown as ReturnType<typeof vi.fn>;
const historyMock = getOrgHistory as unknown as ReturnType<typeof vi.fn>;
const saveMock = setOrgPosition as unknown as ReturnType<typeof vi.fn>;

const person = (id: string, name: string, reportsTo: string | null, extra: Partial<OrgMember> = {}): OrgMember => ({
  id,
  name,
  email: `${id}@example.com`,
  photo_url: null,
  access_role: 'member',
  title: null,
  reports_to_id: reportsTo,
  invite_status: 'active',
  is_me: false,
  since: '2027-01-01T00:00:00Z',
  ...extra,
});

const overview = (over: Partial<OrgOverview> = {}): OrgOverview => ({
  can_manage: true,
  owner: { name: 'Olivia Owner', company: 'Acme HVAC' },
  members: [
    person('ana', 'Ana Alvarez', null, { title: 'Operations Manager', access_role: 'admin' }),
    person('ben', 'Ben Brooks', 'ana', { title: 'Lead Technician', access_role: 'technician' }),
    person('cy', 'Cy Chen', 'ben', { access_role: 'technician', invite_status: 'pending' }),
  ],
  ...over,
});

const renderPage = (url = '/dashboard/team/org-chart') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <OrgChartPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  toast.mockReset();
  overviewMock.mockReset();
  historyMock.mockReset();
  saveMock.mockReset();
  historyMock.mockResolvedValue([
    { id: 'h1', access_role: 'technician', title: 'Lead Technician', reports_to_name: 'Ana Alvarez', started_at: '2027-06-01T00:00:00Z', ended_at: null, note: 'Promoted after certification', changed_by_name: 'Olivia Owner' },
    { id: 'h0', access_role: 'technician', title: null, reports_to_name: null, started_at: '2027-01-01T00:00:00Z', ended_at: '2027-06-01T00:00:00Z', note: null, changed_by_name: null },
  ]);
});
afterEach(cleanup);

describe('OrgChartPage', () => {
  it('shows loading, then the owner at the top with the reporting tree and stats', async () => {
    overviewMock.mockResolvedValue(overview());
    renderPage();
    expect(screen.getByRole('status', { name: /loading org chart/i })).toBeInTheDocument();

    const tree = await screen.findByRole('list', { name: 'Reporting lines' });
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
    expect(within(tree).getByRole('button', { name: /Ana Alvarez, Operations Manager/ })).toBeInTheDocument();
    expect(within(tree).getByRole('button', { name: /Cy Chen/ })).toBeInTheDocument();
    expect(screen.getByText('+ 1 pending invite')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('collapses and expands a manager\'s team', async () => {
    overviewMock.mockResolvedValue(overview());
    renderPage();
    await screen.findByRole('list', { name: 'Reporting lines' });

    fireEvent.click(screen.getByRole('button', { name: "Collapse Ana Alvarez's team" }));
    expect(screen.queryByRole('button', { name: /Ben Brooks/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Expand Ana Alvarez's team" }));
    expect(screen.getByRole('button', { name: /Ben Brooks/ })).toBeInTheDocument();
  });

  it('search keeps the managers above a match and offers a way out when nothing matches', async () => {
    overviewMock.mockResolvedValue(overview());
    renderPage();
    await screen.findByRole('list', { name: 'Reporting lines' });

    fireEvent.change(screen.getByRole('searchbox', { name: /search the org chart/i }), { target: { value: 'cy' } });
    expect(screen.getByRole('button', { name: /Cy Chen/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ben Brooks/ })).toBeInTheDocument(); // manager stays for context

    fireEvent.change(screen.getByRole('searchbox', { name: /search the org chart/i }), { target: { value: 'zzz' } });
    expect(screen.getByText('No one matches your search')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('button', { name: /Ana Alvarez/ })).toBeInTheDocument();
  });

  it('opens a person, shows their role history and never offers their own reports as a manager', async () => {
    overviewMock.mockResolvedValue(overview());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Ben Brooks, Lead Technician/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Ben Brooks' });
    expect(within(dialog).getByText('Ana Alvarez')).toBeInTheDocument();
    expect(await within(dialog).findByText('Promoted after certification')).toBeInTheDocument();
    expect(within(dialog).getByText('Current')).toBeInTheDocument();

    const options = within(within(dialog).getByLabelText('Reports to') as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => o?.startsWith('Olivia Owner'))).toBe(true);
    expect(options.some((o) => o?.startsWith('Cy Chen'))).toBe(false); // Cy reports to Ben
    expect(options.some((o) => o?.startsWith('Ben Brooks'))).toBe(false);
  });

  it('saves a new title and manager, then refreshes the chart', async () => {
    overviewMock.mockResolvedValue(overview());
    saveMock.mockResolvedValue(true);
    renderPage('/dashboard/team/org-chart?member=ben');

    const dialog = await screen.findByRole('dialog', { name: 'Ben Brooks' });
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Job title'), { target: { value: 'Senior Technician' } });
    fireEvent.change(within(dialog).getByLabelText('Reports to'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Moved to owner' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ memberId: 'ben', title: 'Senior Technician', reportsTo: null, note: 'Moved to owner' }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Ben Brooks's position was updated.", 'success'));
    expect(overviewMock).toHaveBeenCalledTimes(2);
  });

  it('shows the database message when a change is rejected', async () => {
    overviewMock.mockResolvedValue(overview());
    saveMock.mockRejectedValue({ code: 'P0001', message: 'That would create a reporting loop' });
    renderPage('/dashboard/team/org-chart?member=ben');

    const dialog = await screen.findByRole('dialog', { name: 'Ben Brooks' });
    fireEvent.change(within(dialog).getByLabelText('Job title'), { target: { value: 'Foreman' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That would create a reporting loop');
  });

  it('is read-only for people who cannot manage the team', async () => {
    overviewMock.mockResolvedValue(
      overview({ can_manage: false, members: [person('ana', 'Ana Alvarez', null, { email: null }), person('ben', 'Ben Brooks', 'ana', { email: null, is_me: true })] }),
    );
    renderPage('/dashboard/team/org-chart?member=ana');

    const dialog = await screen.findByRole('dialog', { name: 'Ana Alvarez' });
    expect(within(dialog).queryByRole('form', { name: 'Edit position' })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/visible to managers and to the person themselves/)).toBeInTheDocument();
    expect(historyMock).not.toHaveBeenCalled();
  });

  it('shows an empty state for an owner with no team', async () => {
    overviewMock.mockResolvedValue(overview({ members: [] }));
    renderPage();
    expect(await screen.findByText('Your org chart starts with you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite team members' })).toBeInTheDocument();
  });

  it('shows an error with retry, and recovers', async () => {
    overviewMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(overview());
    renderPage();
    expect(await screen.findByText("We couldn't load the org chart")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Reporting lines' })).toBeInTheDocument();
  });
});
