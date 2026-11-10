import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  access: { ready: true, enabled: true },
  auth: { isOwner: true, permissions: { can_edit_business_profile: true }, teamMember: null as null | { role: string } },
  ownerId: 'owner1' as string | null,
}));

vi.mock('@/hooks/usePestOpsAccess', () => ({ usePestOpsAccess: () => state.access }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/customFieldsApi', () => ({ useAccountOwnerId: () => state.ownerId }));
vi.mock('@/components/pestOps/PlansPanel', () => ({ PlansPanel: (p: { canManage: boolean }) => <div>plans panel manage={String(p.canManage)}</div> }));
vi.mock('@/components/pestOps/CallbacksPanel', () => ({ CallbacksPanel: () => <div>callbacks panel</div> }));
vi.mock('@/components/pestOps/NoticesPanel', () => ({ NoticesPanel: () => <div>notices panel</div> }));
vi.mock('@/components/pestOps/StockPanel', () => ({ StockPanel: () => <div>stock panel</div> }));
vi.mock('@/components/pestOps/RegionPanel', () => ({ RegionPanel: () => <div>rules panel</div> }));

import { PestOpsPage } from './PestOpsPage';

const renderPage = () => render(<MemoryRouter><PestOpsPage /></MemoryRouter>);

describe('PestOpsPage gate', () => {
  beforeEach(() => {
    state.access = { ready: true, enabled: true };
    state.auth = { isOwner: true, permissions: { can_edit_business_profile: true }, teamMember: null };
    state.ownerId = 'owner1';
  });
  afterEach(cleanup);

  it('shows a loading skeleton, not the module, until access is known', () => {
    state.access = { ready: false, enabled: false };
    renderPage();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(/Pest Ops is not enabled/)).toBeNull();
  });

  it('shows nothing of the module when the flag/entitlement is off', () => {
    state.access = { ready: true, enabled: false };
    renderPage();
    expect(screen.getByText(/Pest Ops is not enabled/)).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(/plans panel/)).toBeNull();
  });

  it('renders the tabs and switches panels when enabled', () => {
    renderPage();
    expect(screen.getByRole('tablist', { name: /Pest Ops sections/ })).toBeTruthy();
    expect(screen.getByText(/plans panel manage=true/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Stock' }));
    expect(screen.getByText('stock panel')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Stock' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a team member without the business-profile permission is not a manager', () => {
    state.auth = { isOwner: false, permissions: { can_edit_business_profile: false }, teamMember: { role: 'technician' } };
    renderPage();
    expect(screen.getByText(/plans panel manage=false/)).toBeTruthy();
  });
});
