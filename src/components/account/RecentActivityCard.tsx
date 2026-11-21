import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, KeyRound, Laptop, LogIn, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/accountHelpers';
import {
  fromLoginEvent,
  fromSecurityEvent,
  mergeActivity,
  type ActivityItem,
  type ActivityKind,
  type LoginEventRowLike,
  type SecurityEventRowLike,
} from '@/lib/activityFeed';

const LIMIT = 5;

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

const LABELS: Record<ActivityKind, string> = {
  sign_in: 'Signed in',
  sign_in_new_device: 'Signed in from a new device',
  password_changed: 'Password changed',
  email_changed: 'Email address changed',
  mfa_enrolled: 'Two-step verification turned on',
  mfa_disabled: 'Two-step verification turned off',
  recovery_codes_regenerated: 'Recovery codes regenerated',
  api_key_created: 'API key created',
  api_key_revoked: 'API key revoked',
};

const WARN: ReadonlySet<ActivityKind> = new Set<ActivityKind>(['sign_in_new_device', 'email_changed', 'mfa_disabled']);

/** Same two tables/columns as fetchAccountActivity (RLS scopes both to the signed-in user), but only the latest few rows. */
async function fetchRecent(userId: string): Promise<ActivityItem[]> {
  const [security, logins] = await Promise.all([
    supabase.from('security_events').select('id,event,occurred_at,meta,acknowledged_at').eq('user_id', userId).order('occurred_at', { ascending: false }).limit(LIMIT),
    supabase.from('login_events').select('id,device_label,is_new_device,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(LIMIT),
  ]);
  if (security.error) throw security.error;
  if (logins.error) throw logins.error;
  return mergeActivity(
    ((security.data ?? []) as SecurityEventRowLike[]).map(fromSecurityEvent).filter((i): i is ActivityItem => i !== null),
    ((logins.data ?? []) as LoginEventRowLike[]).map(fromLoginEvent),
  ).slice(0, LIMIT);
}

export function RecentActivityCard() {
  const { t, i18n } = useTranslation('dashboard');
  const { user } = useAuth();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setFailed(false);
    setItems(null);
    try {
      setItems(await fetchRecent(user.id));
    } catch {
      setFailed(true);
    }
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      {failed ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p className="text-sm text-text-secondary">{t('account.activity.failed', { defaultValue: "Couldn't load your recent activity." })}</p>
          <button type="button" onClick={() => void load()} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary">
            <RotateCw size={12} aria-hidden="true" />
            {t('account.activity.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      ) : items === null ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-bg-tertiary" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-secondary">{t('account.activity.empty', { defaultValue: 'No recent account activity yet.' })}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70 bg-bg-primary">
          {items.map((item) => {
            const Icon = ICONS[item.kind] ?? Activity;
            const warn = WARN.has(item.kind);
            const detail = item.details.device ?? item.details.key ?? item.details.factor;
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${warn ? 'bg-warning-subtle text-warning' : 'bg-bg-tertiary text-text-secondary'}`}>
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {t(`account.activity.kinds.${item.kind}`, { defaultValue: LABELS[item.kind] ?? item.kind })}
                  </span>
                  {detail && <span className="block truncate text-xs text-text-secondary">{detail}</span>}
                </span>
                <time dateTime={item.at} className="shrink-0 text-xs text-text-muted">
                  {timeAgo(item.at, i18n.language)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 text-end">
        <Link to="/dashboard/settings/activity" className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
          {t('account.activity.viewAll', { defaultValue: 'View all activity' })}
        </Link>
      </div>
    </div>
  );
}
