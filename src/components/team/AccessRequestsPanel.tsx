import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { listPendingForReview, resolveAccessRequest, type AccessRequest } from '@/lib/accessRequests';

/** Pending access requests from team members. Renders nothing for people who cannot review. */
export function AccessRequestsPanel() {
  const { t } = useTranslation();
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<AccessRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canReview = isOwner || permissions.can_edit_business_profile;

  const load = useCallback(async () => {
    const rows = await listPendingForReview();
    setItems(rows.filter((r) => r.requester_id !== user?.id));
  }, [user?.id]);

  useEffect(() => {
    if (canReview) void load();
  }, [canReview, load]);

  if (!canReview || items.length === 0) return null;

  async function resolve(id: string, status: 'approved' | 'dismissed') {
    setBusyId(id);
    const ok = await resolveAccessRequest(id, status);
    setBusyId(null);
    if (!ok) {
      toast(t('navflow.requests.failed', { defaultValue: 'Could not update the request.' }), 'error');
      return;
    }
    toast(
      status === 'approved'
        ? t('navflow.requests.approvedToast', { defaultValue: 'Marked as handled. Update their permissions below to grant access.' })
        : t('navflow.requests.dismissedToast', { defaultValue: 'Request dismissed.' }),
      'success',
    );
    setItems((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <section aria-labelledby="access-requests-title" className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <h2 id="access-requests-title" className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <KeyRound size={18} className="text-accent" aria-hidden="true" />
        {t('navflow.requests.title', { defaultValue: 'Access requests' })}
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{items.length}</span>
      </h2>
      <ul className="mt-3 divide-y divide-border">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-text-primary">
                {r.requester_name ?? t('navflow.requests.someone', { defaultValue: 'A team member' })}
                <span className="font-normal text-text-secondary"> — </span>
                <code className="break-all text-xs text-text-secondary">{r.path}</code>
              </p>
              {r.message && <p className="mt-1 whitespace-pre-wrap break-words text-text-secondary">{r.message}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => void resolve(r.id, 'dismissed')}>
                {t('navflow.requests.dismiss', { defaultValue: 'Dismiss' })}
              </Button>
              <Button size="sm" disabled={busyId === r.id} onClick={() => void resolve(r.id, 'approved')}>
                {t('navflow.requests.handled', { defaultValue: 'Mark handled' })}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
