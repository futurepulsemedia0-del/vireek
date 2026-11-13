import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({ access: { loading: false, allowed: false } }));
vi.mock('@/lib/landscapingApi', () => ({ useLandscapingAccess: () => state.access }));
vi.mock('@/lib/customFieldsApi', () => ({ useAccountOwnerId: () => 'owner1' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, teamMember: null }) }));
// Panels are heavy and covered by their own logic tests; here we only assert gating + navigation semantics.
vi.mock('@/components/landscaping/RouteBoardPanel', () => ({ RouteBoardPanel: () => <div>route-board</div> }));
vi.mock('@/components/landscaping/ContractsPanel', () => ({ ContractsPanel: () => <div>contracts</div> }));
vi.mock('@/components/landscaping/PropertiesPanel', () => ({ PropertiesPanel: () => <div>properties</div> }));
vi.mock('@/components/landscaping/CrewsPanel', () => ({ CrewsPanel: () => <div>crews</div> }));
vi.mock('@/components/landscaping/BillingPanel', () => ({ BillingPanel: () => <div>billing</div> }));
vi.mock('@/components/landscaping/PerformancePanel', () => ({ PerformancePanel: () => <div>performance</div> }));

import { LandscapingPage } from './LandscapingPage';

const renderPage = () => render(<MemoryRouter><LandscapingPage /></MemoryRouter>);
afterEach(cleanup);

describe('LandscapingPage gating', () => {
  it('shows a neutral not-available state and loads no panel when the module is not enabled', () => {
    state.access = { loading: false, allowed: false };
    renderPage();
    expect(screen.getByText(/not available on this account/i)).toBeTruthy();
    expect(screen.queryByText('route-board')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
  it('shows a busy skeleton (not the page, not the denial) while access is being checked', () => {
    state.access = { loading: true, allowed: false };
    const { container } = renderPage();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText(/not available/i)).toBeNull();
  });
  it('renders the workspace with accessible tabs when allowed', () => {
    state.access = { loading: false, allowed: true };
    renderPage();
    expect(screen.getByRole('tablist', { name: /landscaping sections/i })).toBeTruthy();
    expect(screen.getAllByRole('tab').length).toBe(6);
    expect(screen.getByText('route-board')).toBeTruthy();
  });
});
