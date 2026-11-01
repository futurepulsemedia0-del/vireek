import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Download, KeyRound, Laptop, LogIn, ShieldAlert, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonTable } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useSecurityT } from '@/i18n/securityNamespace';
import { fetchAccountActivity } from '@/lib/activityApi';
import { filterActivity, toCsv, type ActivityCategory, type ActivityFilters, type ActivityItem, type ActivityKind } from '@/lib/activityFeed';

const CATEGORIES: Array<ActivityCategory | 'all'> = ['all', 'signIn', 'account', 'apiKeys'];
const RANGES: Array<ActivityFilters['rangeDays']> = [7, 30, 90, 'all'];

const ICONS: Record<ActivityKind, typeof LogIn> = {
  sign_in: LogIn,
  sign_in_new_device: Laptop,
  password_changed: ShieldCheck,
  email_changed: ShieldAlert,
  mfa_enrolled: ShieldCheck,
  mfa_disabled: ShieldAlert,
  recovery_codes_regenerated: ShieldCheck,
  api_key_created: KeyRound,
  api_key_revoked: KeyRound,
};

const selectClass = 'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

export function AccountActivityPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t, language } = useSecurityT();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState<ActivityFilters>({ category: 'all', rangeDays: 30 });
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setError(false);
    try {
      setItems(await fetchAccountActivity(user.id));
    } catch {
      setError(true);
    }
  }, [user]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => (items ? filterActivity(items, filters, Date.now()) : []), [items, filters]);
  const fmt = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }), [language]);

  const exportCsv = () => {
    setExporting(true);
    try {
      const csv = toCsv(visible, (k) => t(`activity.events.${k}`), { time: t('activity.csvHeaders.time'), event: t('activity.csvHeaders.event'), details: t('activity.csvHeaders.details') });
      const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `vireek-account-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast(t('activity.exportFailed'), 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Settings">
      <BackButton to="/dashboard/settings/security" />
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{t('activity.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('activity.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/settings/sessions" className="focus-ring inline-flex min-h-[40px] items-center rounded-xl border border-border bg-bg-secondary px-4 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
            {t('activity.reviewSessions')}
          </Link>
          <Button size="sm" variant="secondary" onClick={exportCsv} disabled={exporting || visible.length === 0}>
            <Download size={16} aria-hidden="true" />
            {exporting ? t('activity.exporting') : t('activity.export')}
          </Button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-4">
        <label className="text-sm text-text-secondary">
          <span className="mb-1 block font-medium text-text-primary">{t('activity.filters.category')}</span>
          <select className={selectClass} value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value as ActivityFilters['category'] })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`activity.filters.categories.${c}`)}</option>)}
          </select>
        </label>
        <label className="text-sm text-text-secondary">
          <span className="mb-1 block font-medium text-text-primary">{t('activity.filters.range')}</span>
          <select
            className={selectClass}
            value={String(filters.rangeDays)}
            onChange={(e) => setFilters({ ...filters, rangeDays: e.target.value === 'all' ? 'all' : (Number(e.target.value) as 7 | 30 | 90) })}
          >
            {RANGES.map((r) => <option key={String(r)} value={String(r)}>{t(`activity.filters.ranges.${r}`)}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <EmptyState icon={ShieldAlert} title={t('activity.loadFailed')} action={{ label: t('activity.retry'), onClick: () => void load() }} />
      ) : items === null ? (
        <SkeletonTable />
      ) : visible.length === 0 ? (
        <EmptyState icon={Activity} title={t('activity.empty.title')} description={t('activity.empty.description')} />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border" aria-label={t('activity.title')}>
            {visible.map((i) => {
              const Icon = ICONS[i.kind];
              const detail = [i.details.device, i.details.key, i.details.factor].filter(Boolean).join(' · ');
              return (
                <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{t(`activity.events.${i.kind}`)}</p>
                    {detail && <p className="truncate text-xs text-text-secondary">{detail}</p>}
                  </div>
                  <time dateTime={i.at} className="shrink-0 text-xs text-text-secondary">{fmt.format(new Date(i.at))}</time>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </DashboardLayout>
  );
}

export default AccountActivityPage;
