import { describe, expect, it } from 'vitest';
import { shouldHostDashboardShell } from './DashboardShellSwitch';

describe('shouldHostDashboardShell', () => {
  it('hosts the shell on dashboard pages', () => {
    expect(shouldHostDashboardShell('/dashboard')).toBe(true);
    expect(shouldHostDashboardShell('/dashboard/jobs/123')).toBe(true);
  });
  it('skips non-dashboard and chromeless routes', () => {
    expect(shouldHostDashboardShell('/staff/usage')).toBe(false);
    expect(shouldHostDashboardShell('/dashboardx')).toBe(false);
    expect(shouldHostDashboardShell('/dashboard/today/tv')).toBe(false);
    expect(shouldHostDashboardShell('/dashboard/expert-assist/abc')).toBe(false);
  });
});
