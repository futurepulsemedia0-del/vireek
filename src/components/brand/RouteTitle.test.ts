import { describe, expect, it } from 'vitest';
import { routeLabel } from '@/components/brand/RouteTitle';

describe('routeLabel', () => {
  it('labels app routes from their last meaningful segment', () => {
    expect(routeLabel('/dashboard')).toBe('Dashboard');
    expect(routeLabel('/dashboard/team/org-chart')).toBe('Org chart');
    expect(routeLabel('/dashboard/jobs/3f2b8c1e-1111-2222-3333-444455556666')).toBe('Jobs');
    expect(routeLabel('/tech/pay/')).toBe('Pay');
  });
  it('ignores marketing and token routes (they own their titles)', () => {
    expect(routeLabel('/pricing')).toBeNull();
    expect(routeLabel('/book/abc')).toBeNull();
  });
});
