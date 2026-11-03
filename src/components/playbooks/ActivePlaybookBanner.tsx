import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchBanner, type BannerInfo } from '@/lib/playbookLibrary';
import { formatDateTime } from '@/lib/format';

/**
 * Shows which operating playbook is live (visible to every team member; the payload from
 * playbook_banner() contains only the name and end time). Mounted next to SurgeModeBanner.
 */
export function ActivePlaybookBanner() {
  const { user } = useAuth();
  const [info, setInfo] = useState<BannerInfo | null>(null);

  const load = useCallback(() => {
    fetchBanner().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    if (!user) { setInfo(null); return; }
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, [user, load]);

  if (!info) return null;
  const extra = info.activeCount > 1 ? ` (+${info.activeCount - 1} more)` : '';
  return (
    <div role="status" className="mb-6 flex flex-col gap-2 rounded-2xl border border-accent/30 bg-accent/[0.07] p-4 shadow-card dark:shadow-card-dark sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><BookOpenCheck size={18} /></span>
        <div>
          <p className="text-sm font-semibold text-text-primary">Playbook active: {info.name}{extra}</p>
          <p className="text-xs text-text-secondary">Ends automatically {formatDateTime(info.endsAt)}.</p>
        </div>
      </div>
      {info.canManage && (
        <Link to="/dashboard/playbook-library?tab=active" className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-center text-sm font-medium text-text-primary hover:bg-bg-tertiary">
          Review or roll back
        </Link>
      )}
    </div>
  );
}
