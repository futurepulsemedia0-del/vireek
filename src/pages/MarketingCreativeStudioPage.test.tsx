import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const auth = {
  profile: { id: 'owner-1', company_name: 'Acme HVAC' },
  teamMember: null as { account_owner_id: string } | null,
  isOwner: true,
  permissions: { can_edit_business_profile: true },
  loading: false,
  profileLoading: false,
};

type Result = { data: unknown; error: { message: string } | null };
let results: Record<string, Result> = {};
const ownerFilters: string[] = [];
const invoke = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/x.png' }, error: null }), remove: async () => ({}) }) },
    from: (table: string) => {
      const chain: unknown = new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === 'then') {
              const result = results[table] ?? { data: [], error: null };
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
            }
            return (...args: unknown[]) => {
              if (prop === 'eq' && args[0] === 'user_id') ownerFilters.push(`${table}:${String(args[1])}`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  },
}));

import MarketingCreativeStudioPage from './MarketingCreativeStudioPage';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  user_id: 'owner-1',
  kind: 'article',
  format: 'blog_post',
  status: 'ready',
  source_type: 'custom',
  source_job_id: null,
  source_review_id: null,
  tone: 'friendly',
  goal: 'book_service',
  title: 'Furnace tune-up checklist',
  headline: null,
  caption: null,
  cta: null,
  hashtags: [],
  quote: null,
  body: '## Step one\nCheck the filter and thermostat before winter.',
  meta_title: 'Furnace tune-up checklist | Acme',
  meta_description: 'A short checklist.',
  slug: 'furnace-tune-up-checklist',
  keywords: ['furnace tune-up'],
  faq: [],
  image_path: null,
  image_prompt: null,
  warnings: [],
  model: null,
  calendar_item_id: null,
  created_by: null,
  created_at: '2028-01-02T10:00:00Z',
  updated_at: '2028-01-02T10:00:00Z',
  ...over,
});

beforeEach(() => {
  results = {};
  ownerFilters.length = 0;
  invoke.mockReset();
  auth.isOwner = true;
  auth.permissions = { can_edit_business_profile: true };
});

describe('MarketingCreativeStudioPage', () => {
  it('blocks users without permission', () => {
    auth.isOwner = false;
    auth.teamMember = { account_owner_id: 'owner-1' };
    auth.permissions = { can_edit_business_profile: false };
    render(<MarketingCreativeStudioPage />);
    expect(screen.getByText(/don't have access to the Creative Studio/i)).toBeTruthy();
    expect(ownerFilters).toHaveLength(0);
    auth.teamMember = null;
  });

  it('shows the empty state and scopes every query to the account owner', async () => {
    render(<MarketingCreativeStudioPage />);
    expect(await screen.findByText('Nothing created yet')).toBeTruthy();
    expect(ownerFilters).toContain('marketing_creatives:owner-1');
    expect(ownerFilters).toContain('jobs:owner-1');
    expect(ownerFilters).toContain('reviews:owner-1');
  });

  it('lists creatives from the library', async () => {
    results.marketing_creatives = { data: [row(), row({ id: 'c2', title: 'Ad for AC repair', kind: 'image', format: 'social_square', image_path: 'owner-1/c2.png', body: null, status: 'approved' })], error: null };
    render(<MarketingCreativeStudioPage />);
    expect(await screen.findByText('Furnace tune-up checklist')).toBeTruthy();
    expect(screen.getByText('Ad for AC repair')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Articles' }));
    expect(screen.queryByText('Ad for AC repair')).toBeNull();
  });

  it('shows an error with retry when the library fails to load', async () => {
    results.marketing_creatives = { data: null, error: { message: 'boom' } };
    render(<MarketingCreativeStudioPage />);
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('validates before calling the backend', async () => {
    render(<MarketingCreativeStudioPage />);
    await screen.findByText('Nothing created yet');
    fireEvent.click(screen.getByRole('tab', { name: 'My own idea' }));
    fireEvent.click(screen.getByRole('button', { name: /create image \+ copy/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('generates an article from an idea and opens it', async () => {
    invoke.mockResolvedValue({ data: { creative: row({ id: 'new1', title: 'Brand new article' }) }, error: null });
    render(<MarketingCreativeStudioPage />);
    await screen.findByText('Nothing created yet');
    fireEvent.click(screen.getByRole('button', { name: /blog post/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'My own idea' }));
    fireEvent.change(screen.getByLabelText(/what's it about/i), { target: { value: 'Fall furnace tune-ups' } });
    fireEvent.click(screen.getByRole('button', { name: /write article/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const [fn, opts] = invoke.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(fn).toBe('marketing-creative-generate');
    expect(opts.body.format).toBe('blog_post');
    expect(opts.body.topic).toBe('Fall furnace tune-ups');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('surfaces a backend error message', async () => {
    invoke.mockResolvedValue({ data: { error: 'Hourly limit reached' }, error: null });
    render(<MarketingCreativeStudioPage />);
    await screen.findByText('Nothing created yet');
    fireEvent.click(screen.getByRole('tab', { name: 'My own idea' }));
    fireEvent.change(screen.getByLabelText(/what's it about/i), { target: { value: 'Spring AC check' } });
    fireEvent.click(screen.getByRole('button', { name: /create image \+ copy/i }));
    expect(await screen.findByText('Hourly limit reached')).toBeTruthy();
  });
});
