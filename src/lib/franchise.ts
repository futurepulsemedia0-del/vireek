export interface FranchiseGroup {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}

export type FranchiseLocationStatus = 'invited' | 'active' | 'declined';

export interface FranchiseLocation {
  id: string;
  franchise_group_id: string;
  location_profile_id: string | null;
  invited_email: string;
  label: string;
  status: FranchiseLocationStatus;
  invited_at: string;
  joined_at: string | null;
}

export interface FranchiseLocationStats {
  location_id: string;
  label: string;
  company_name: string | null;
  status: FranchiseLocationStatus;
  calls_30d: number;
  emergency_calls_30d: number;
  jobs_30d: number;
  revenue_30d: number;
  avg_rating: number | null;
}

export interface PendingFranchiseInvite {
  id: string;
  franchise_group_id: string;
  franchise_name: string;
  label: string;
  invited_at: string;
}

export function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatRating(rating: number | null): string {
  return rating === null ? '—' : rating.toFixed(1);
}

export function sumStats(stats: FranchiseLocationStats[]) {
  const activeOnly = stats.filter((s) => s.status === 'active');
  const ratings = activeOnly.map((s) => s.avg_rating).filter((r): r is number => r !== null);
  return {
    totalCalls: activeOnly.reduce((sum, s) => sum + s.calls_30d, 0),
    totalEmergencyCalls: activeOnly.reduce((sum, s) => sum + s.emergency_calls_30d, 0),
    totalJobs: activeOnly.reduce((sum, s) => sum + s.jobs_30d, 0),
    totalRevenue: activeOnly.reduce((sum, s) => sum + s.revenue_30d, 0),
    avgRating: ratings.length ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length : null,
    activeLocations: activeOnly.length,
  };
}
