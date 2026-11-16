import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StaffAiIncidentsPage } from '@/pages/admin/StaffAiIncidentsPage';
import { toIncident } from '@/lib/aiIncidents';
import en from '@/locales/en/aiIncidents.json';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

// Real English strings from the shipped locale file, with {{var}} interpolation.
vi.mock('@/i18n/aiIncidentsNamespace', () => ({
  useAiIncidentsT: () => ({
    language: 'en',
    t: (key: string, vars?: Record<string, unknown>) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(vars?.[n] ?? '')) : key;
    },
  }),
}));

const api = vi.hoisted(() => {
  class AiIncidentsApiError extends Error {
    kind: string;
    constructor(kind: string) { super(kind); this.kind = kind; }
  }
  return { AiIncidentsApiError, listAiIncidents: vi.fn(), createAiIncident: vi.fn(), updateAiIncident: vi.fn() };
});
vi.mock('@/lib/aiIncidentsApi', () => api);

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'i1', ref: 'AI-2029-00001', incident_type: 'pii_leak_on_call', severity: 'critical', status: 'investigating',
  title: 'Agent read back another caller’s address', summary: 'The agent disclosed an address belonging to a different caller.',
  source: 'ai_security_event', owner_role: 'security_lead', call_id: 'call_123',
  customer_notification: 'not_assessed', regulator_notification: 'not_assessed', postmortem_ref: null,
  detected_at: '2029-03-04T10:00:00Z', contained_at: null, resolved_at: null, created_at: '2029-03-04T10:00:00Z', updated_at: '2029-03-04T10:00:00Z',
  ...over,
});

const critical = toIncident(raw());
const medium = toIncident(raw({ id: 'i2', ref: 'AI-2029-00002', incident_type: 'wrong_price_commitment', severity: 'medium', status: 'open', title: 'Agent quoted the wrong price', call_id: null }));
const closed = toIncident(raw({ id: 'i3', ref: 'AI-2029-00003', severity: 'low', status: 'closed', title: 'Old near miss', detected_at: '2029-01-01T10:00:00Z' }));
const high = toIncident(raw({ id: 'i4', ref: 'AI-2029-00004', incident_type: 'discriminatory_behavior', severity: 'high', status: 'contained', title: 'Agent used demeaning language' }));

beforeEach(() => {
  vi.clearAllMocks();
  api.listAiIncidents.mockResolvedValue([medium, closed, critical]);
});
afterEach(() => cleanup());

const card = (title: string) => screen.getByRole('listitem', { name: title });

describe('StaffAiIncidentsPage: list', () => {
  it('shows a loading status first, then the active incidents most severe first, hiding closed ones', async () => {
    let resolve!: (v: unknown) => void;
    api.listAiIncidents.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<StaffAiIncidentsPage />);
    expect(screen.getAllByRole('status').some((el) => el.textContent === en.loading)).toBe(true);
    resolve([medium, closed, critical]);
    expect(await screen.findByText(critical.title)).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(critical.title);
    expect(items[1]).toHaveTextContent(medium.title);
    expect(screen.queryByText('Old near miss')).not.toBeInTheDocument();
  });

  it('shows summary counts', async () => {
    render(<StaffAiIncidentsPage />);
    await screen.findByText(critical.title);
    expect(screen.getByText(en.stats.active).nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText(en.stats.critical).nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText(en.stats.awaitingNotification).nextElementSibling).toHaveTextContent('1');
  });

  it('the status filter can reveal closed incidents', async () => {
    render(<StaffAiIncidentsPage />);
    await screen.findByText(critical.title);
    // The page-level filter is the first control labelled "Status" (the per-card ones come after it).
    fireEvent.change(screen.getAllByLabelText(en.filters.status)[0], { target: { value: 'all' } });
    expect(await screen.findByText('Old near miss')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('shows a filtered-empty state when nothing matches', async () => {
    render(<StaffAiIncidentsPage />);
    await screen.findByText(critical.title);
    fireEvent.change(screen.getAllByLabelText(en.filters.severity)[0], { target: { value: 'low' } });
    expect(await screen.findByText(en.empty.filteredTitle)).toBeInTheDocument();
  });

  it('shows an empty state when there are no incidents at all', async () => {
    api.listAiIncidents.mockResolvedValue([]);
    render(<StaffAiIncidentsPage />);
    expect(await screen.findByText(en.empty.title)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('always shows the no-personal-data notice', async () => {
    render(<StaffAiIncidentsPage />);
    expect(screen.getByRole('note')).toHaveTextContent(en.privacy);
    await screen.findByText(critical.title);
  });
});

describe('StaffAiIncidentsPage: errors', () => {
  it('shows a load error and recovers on refresh', async () => {
    api.listAiIncidents.mockRejectedValueOnce(new api.AiIncidentsApiError('generic'));
    render(<StaffAiIncidentsPage />);
    expect(await screen.findByText(en.loadError)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(en.report, 'i') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.refresh}$`, 'i') }));
    expect(await screen.findByText(critical.title)).toBeInTheDocument();
    expect(api.listAiIncidents).toHaveBeenCalledTimes(2);
  });

  it('shows a permission message (and no data) for a non-staff caller', async () => {
    api.listAiIncidents.mockRejectedValueOnce(new api.AiIncidentsApiError('forbidden'));
    render(<StaffAiIncidentsPage />);
    expect(await screen.findByText(en.forbidden)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('StaffAiIncidentsPage: create', () => {
  const open = async () => {
    render(<StaffAiIncidentsPage />);
    await screen.findByText(critical.title);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.report, 'i') }));
    return screen.getByRole('form', { name: en.form.heading });
  };

  it('blocks submit and shows translated errors when required fields are empty', async () => {
    const form = await open();
    fireEvent.click(within(form).getByRole('button', { name: en.form.submit }));
    expect((await within(form).findAllByText(en.errors.required)).length).toBe(2);
    expect(api.createAiIncident).not.toHaveBeenCalled();
  });

  it('rejects an e-mail address in the summary before any request is made', async () => {
    const form = await open();
    fireEvent.change(within(form).getByLabelText(/^Title/), { target: { value: 'Wrong price quoted' } });
    fireEvent.change(within(form).getByLabelText(/what happened/i), { target: { value: 'Caller jane@example.com was quoted a wrong price.' } });
    fireEvent.click(within(form).getByRole('button', { name: en.form.submit }));
    expect(await within(form).findByText(en.errors.email)).toBeInTheDocument();
    expect(api.createAiIncident).not.toHaveBeenCalled();
  });

  it('applies the policy default severity and owner when the type changes', async () => {
    const form = await open();
    fireEvent.change(within(form).getByLabelText(en.form.type), { target: { value: 'pii_leak_on_call' } });
    expect(within(form).getByLabelText(en.form.severity)).toHaveValue('critical');
    expect(within(form).getByLabelText(en.form.owner)).toHaveValue('security_lead');
  });

  it('creates the incident, closes the form, shows it in the list and confirms with a toast', async () => {
    const created = toIncident(raw({ id: 'i9', ref: 'AI-2029-00009', incident_type: 'wrong_diagnosis', severity: 'medium', status: 'open', title: 'Wrong refrigerant advice', call_id: null }));
    api.createAiIncident.mockResolvedValue(created);
    const form = await open();
    fireEvent.change(within(form).getByLabelText(/^Title/), { target: { value: 'Wrong refrigerant advice' } });
    fireEvent.change(within(form).getByLabelText(/what happened/i), { target: { value: 'The agent gave wrong refrigerant guidance to one technician.' } });
    fireEvent.click(within(form).getByRole('button', { name: en.form.submit }));
    await waitFor(() => expect(api.createAiIncident).toHaveBeenCalledTimes(1));
    expect(api.createAiIncident.mock.calls[0][0]).toMatchObject({ title: 'Wrong refrigerant advice', incidentType: 'wrong_diagnosis', severity: 'medium' });
    expect(await screen.findByText('Wrong refrigerant advice')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: en.form.heading })).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('Incident AI-2029-00009 created.', 'success');
  });

  it('keeps the form and shows a translated error when the server refuses (personal data)', async () => {
    api.createAiIncident.mockRejectedValue(new api.AiIncidentsApiError('pii'));
    const form = await open();
    fireEvent.change(within(form).getByLabelText(/^Title/), { target: { value: 'Wrong price quoted' } });
    fireEvent.change(within(form).getByLabelText(/what happened/i), { target: { value: 'The agent quoted ninety-nine dollars instead of one-ninety-nine.' } });
    fireEvent.click(within(form).getByRole('button', { name: en.form.submit }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(en.errors.pii, 'error'));
    expect(screen.getByRole('form', { name: en.form.heading })).toBeInTheDocument();
  });
});

describe('StaffAiIncidentsPage: update', () => {
  it('cannot close a critical incident without a postmortem reference, then can once one is entered', async () => {
    const updated = toIncident(raw({ status: 'closed', postmortem_ref: 'docs/postmortems/AI-2029-00001.md' }));
    api.updateAiIncident.mockResolvedValue(updated);
    render(<StaffAiIncidentsPage />);
    await screen.findByText(critical.title);
    const c = within(card(critical.title));
    const save = c.getByRole('button', { name: en.row.save });
    expect(save).toBeDisabled(); // nothing changed yet

    fireEvent.change(c.getByLabelText(en.row.status), { target: { value: 'closed' } });
    expect(c.getByText(en.errors.postmortemRequired)).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(c.getByLabelText(en.row.postmortemRef), { target: { value: 'docs/postmortems/AI-2029-00001.md' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.updateAiIncident).toHaveBeenCalledTimes(1));
    expect(api.updateAiIncident).toHaveBeenCalledWith('i1', {
      status: 'closed', customerNotification: 'not_assessed', regulatorNotification: 'not_assessed', postmortemRef: 'docs/postmortems/AI-2029-00001.md',
    });
    expect(toast).toHaveBeenCalledWith('Incident AI-2029-00001 updated.', 'success');
  });

  it('records a notification decision', async () => {
    api.listAiIncidents.mockResolvedValue([high]);
    api.updateAiIncident.mockResolvedValue(toIncident(raw({ id: 'i4', severity: 'high', status: 'contained', customer_notification: 'counsel_review' })));
    render(<StaffAiIncidentsPage />);
    await screen.findByText(high.title);
    const c = within(card(high.title));
    fireEvent.change(c.getByLabelText(en.row.customerNotification), { target: { value: 'counsel_review' } });
    fireEvent.click(c.getByRole('button', { name: en.row.save }));
    await waitFor(() => expect(api.updateAiIncident).toHaveBeenCalledWith('i4', expect.objectContaining({ customerNotification: 'counsel_review', status: 'contained' })));
  });

  it('shows a translated error and keeps the edit when the server rejects the update', async () => {
    api.updateAiIncident.mockRejectedValue(new api.AiIncidentsApiError('postmortemRequired'));
    render(<StaffAiIncidentsPage />);
    await screen.findByText(medium.title);
    const c = within(card(medium.title));
    fireEvent.change(c.getByLabelText(en.row.status), { target: { value: 'closed' } });
    fireEvent.click(c.getByRole('button', { name: en.row.save }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(en.errors.postmortemRequired, 'error'));
    expect(c.getByLabelText(en.row.status)).toHaveValue('closed');
  });
});
