import { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Mail, MessageSquare, Phone, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { CASE_STATUS_LABELS, SURVEY_TYPE_LABELS, type CaseStatus, type RecoveryCase } from '@/lib/surveys';

type Filter = 'active' | 'closed' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Needs action' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const statusStyle: Record<CaseStatus, string> = {
  open: 'bg-danger/10 text-danger',
  contacted: 'bg-warning-500/10 text-warning-500',
  resolved: 'bg-success-500/10 text-success-500',
  dismissed: 'bg-bg-tertiary text-text-secondary',
};

export function RecoveryCasesPanel({
  cases,
  canEdit,
  onUpdate,
}: {
  cases: RecoveryCase[];
  canEdit: boolean;
  onUpdate: (id: string, status: CaseStatus, note?: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<Filter>('active');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const visible = useMemo(
    () =>
      cases.filter((c) =>
        filter === 'all' ? true : filter === 'active' ? c.status === 'open' || c.status === 'contacted' : c.status === 'resolved' || c.status === 'dismissed',
      ),
    [cases, filter],
  );
  const activeCount = cases.filter((c) => c.status === 'open' || c.status === 'contacted').length;

  const act = async (c: RecoveryCase, status: CaseStatus, withNote?: string) => {
    setBusyId(c.id);
    const ok = await onUpdate(c.id, status, withNote);
    setBusyId(null);
    if (ok) {
      setResolvingId(null);
      setNote('');
    }
  };

  return (
    <section aria-label="Service recovery cases" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter cases">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`focus-ring min-h-[40px] rounded-full border px-4 text-sm font-medium transition-colors ${
              filter === f.key ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
            }`}
          >
            {f.label}
            {f.key === 'active' && activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={filter === 'closed' ? CheckCircle2 : ShieldAlert}
          title={cases.length === 0 ? 'No unhappy customers — yet' : filter === 'active' ? 'Nothing needs action' : 'No cases here'}
          description={
            cases.length === 0
              ? 'When a customer scores at or below your threshold, a recovery case appears here instantly and you get a notification.'
              : 'Every flagged customer has been handled. Nice work.'
          }
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((c) => {
            const busy = busyId === c.id;
            const closed = c.status === 'resolved' || c.status === 'dismissed';
            return (
              <li key={c.id} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-text-primary">{c.customer_name}</h3>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.severity === 'critical' ? 'bg-danger text-white' : 'bg-danger/10 text-danger'}`}>
                        {c.severity === 'critical' ? 'Critical' : 'High'}
                      </span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle[c.status]}`}>{CASE_STATUS_LABELS[c.status]}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">
                      {SURVEY_TYPE_LABELS[c.survey_type]} score{' '}
                      <strong className="text-text-primary">
                        {c.score}/{c.survey_type === 'nps' ? 10 : 5}
                      </strong>{' '}
                      · {timeAgo(c.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {c.customer_phone && (
                      <>
                        <a href={`tel:${c.customer_phone}`} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium text-text-primary hover:border-accent/50" aria-label={`Call ${c.customer_name}`}>
                          <Phone size={15} aria-hidden="true" /> Call
                        </a>
                        <a href={`sms:${c.customer_phone}`} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium text-text-primary hover:border-accent/50" aria-label={`Text ${c.customer_name}`}>
                          <MessageSquare size={15} aria-hidden="true" /> Text
                        </a>
                      </>
                    )}
                    {c.customer_email && (
                      <a href={`mailto:${c.customer_email}`} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium text-text-primary hover:border-accent/50" aria-label={`Email ${c.customer_name}`}>
                        <Mail size={15} aria-hidden="true" /> Email
                      </a>
                    )}
                  </div>
                </div>

                {c.comment && (
                  <blockquote className="mt-3 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary">“{c.comment}”</blockquote>
                )}
                {c.resolution_note && (
                  <p className="mt-3 text-sm text-text-secondary">
                    <span className="font-medium text-text-primary">Resolution:</span> {c.resolution_note}
                  </p>
                )}

                {canEdit && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {resolvingId === c.id ? (
                      <div className="w-full space-y-3">
                        <Textarea
                          label="What did you do to make it right? (optional)"
                          rows={3}
                          maxLength={2000}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          autoFocus
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" disabled={busy} onClick={() => void act(c, 'resolved', note)}>
                            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                            Mark resolved
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setResolvingId(null); setNote(''); }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : closed ? (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(c, 'open')}>
                        {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
                        Reopen
                      </Button>
                    ) : (
                      <>
                        {c.status === 'open' && (
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(c, 'contacted')}>
                            {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                            Mark contacted
                          </Button>
                        )}
                        <Button size="sm" disabled={busy} onClick={() => { setResolvingId(c.id); setNote(c.resolution_note ?? ''); }}>
                          <CheckCircle2 size={15} aria-hidden="true" /> Resolve
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(c, 'dismissed')}>
                          <X size={15} aria-hidden="true" /> Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
