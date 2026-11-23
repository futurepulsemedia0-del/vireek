/** Staff — /staff/incident-comms (wrapped in <StaffRoute>): draft status post + customer email from an incident, human approval, then publish. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useIncidentCommsT } from '@/i18n/incidentCommsNamespace';
import {
  LIMITS,
  PHASES,
  SEVERITIES,
  allowedAudiences,
  approveBlock,
  approveDraft,
  canSend,
  createDraft,
  fetchOverview,
  isLocked,
  isStale,
  rejectDraft,
  saveRequireSecondApprover,
  sendDraft,
  submitDraft,
  updateDraft,
  type Audience,
  type CommsDraft,
  type CommsIncident,
  type CommsOverview,
  type CommsResult,
  type LintIssue,
  type Phase,
  type Severity,
} from '@/lib/incidentComms';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: CommsOverview };

const SELECT = 'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary';
const TEXTAREA = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

function Issues({ issues }: { issues: LintIssue[] }) {
  const { t } = useIncidentCommsT();
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="rounded-xl border border-warning/40 bg-warning-subtle p-3 text-sm">
      <p className="font-semibold text-text-primary">{t('lint.heading')}</p>
      <ul className="mt-1 list-disc space-y-1 ps-5 text-text-secondary">
        {issues.map((i) => (
          <li key={i.code}>
            <span className={i.level === 'block' ? 'font-semibold text-danger' : 'font-semibold text-warning'}>{t(`lint.${i.level}`)}: </span>
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewDraftForm({ incident, onCreated }: { incident: CommsIncident; onCreated: () => void }) {
  const { t } = useIncidentCommsT();
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>(incident.status === 'resolved' ? 'resolved' : incident.status === 'monitoring' ? 'monitoring' : 'investigating');
  const [severity, setSeverity] = useState<Severity>(incident.impact === 'major' ? 'sev1' : 'sev2');
  const [audience, setAudience] = useState<Audience>('status_page');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<LintIssue[]>([]);

  const audiences = allowedAudiences(severity);
  const effectiveAudience = audiences.includes(audience) ? audience : audiences[0];

  const submit = async () => {
    if (busy || !effectiveAudience) return;
    setBusy(true);
    setIssues([]);
    try {
      const r = await createDraft({ incidentId: incident.id, phase, severity, audience: effectiveAudience, customerAction: action });
      if (r.ok) {
        toast(t('new.created'), 'success');
        setAction('');
        onCreated();
      } else {
        setIssues(r.issues);
        toast(errorText(r, t), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <h2 className="text-base font-semibold text-text-primary">{t('new.heading')}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="ic-phase" className="mb-1 block text-xs font-medium text-text-secondary">{t('new.phase')}</label>
          <select id="ic-phase" className={SELECT} value={phase} onChange={(e) => setPhase(e.target.value as Phase)}>
            {PHASES.map((p) => <option key={p} value={p}>{t(`phase.${p}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ic-sev" className="mb-1 block text-xs font-medium text-text-secondary">{t('new.severity')}</label>
          <select id="ic-sev" className={SELECT} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{t(`severity.${s}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ic-aud" className="mb-1 block text-xs font-medium text-text-secondary">{t('new.audience')}</label>
          <select id="ic-aud" className={SELECT} value={effectiveAudience ?? ''} disabled={audiences.length === 0} onChange={(e) => setAudience(e.target.value as Audience)}>
            {audiences.map((a) => <option key={a} value={a}>{t(`audience.${a}`)}</option>)}
          </select>
        </div>
      </div>
      {audiences.length === 0 && <p className="text-sm text-text-secondary">{t('new.noPublic')}</p>}
      {audiences.length === 1 && audiences[0] === 'status_page' && severity !== 'sev4' && <p className="text-xs text-text-secondary">{t('new.emailNotAllowed')}</p>}
      <Input label={t('new.customerAction')} helperText={t('new.customerActionHelp')} maxLength={300} value={action} onChange={(e) => setAction(e.target.value)} />
      <Issues issues={issues} />
      <Button type="button" loading={busy} disabled={audiences.length === 0} onClick={() => void submit()}>{t('new.create')}</Button>
    </Card>
  );
}

function errorText(r: CommsResult, t: (k: string) => string): string {
  const known = ['forbidden', 'conflict', 'lint_blocked', 'draft_stale'];
  if (r.error && known.includes(r.error)) return r.message && r.error !== 'lint_blocked' ? r.message : t(`errors.${r.error}`);
  return r.message ?? t('errors.generic');
}

function DraftCard({ draft, incident, data, onChanged }: { draft: CommsDraft; incident: CommsIncident; data: CommsOverview; onChanged: () => void }) {
  const { t, language } = useIncidentCommsT();
  const { toast } = useToast();
  const [post, setPost] = useState(draft.statusPostText);
  const [subject, setSubject] = useState(draft.emailSubject ?? '');
  const [body, setBody] = useState(draft.emailBody ?? '');
  const [reviewed, setReviewed] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);

  // Server state changed (approval reset, send finished...): re-sync local fields and clear the "I have read it" tick.
  useEffect(() => {
    setPost(draft.statusPostText);
    setSubject(draft.emailSubject ?? '');
    setBody(draft.emailBody ?? '');
    setReviewed(false);
  }, [draft.contentHash, draft.state, draft.statusPostText, draft.emailSubject, draft.emailBody]);

  const withEmail = draft.audience === 'status_page_and_subscribers';
  const dirty = post !== draft.statusPostText || (withEmail && (subject !== (draft.emailSubject ?? '') || body !== (draft.emailBody ?? '')));
  const locked = isLocked(draft.state);
  const block = approveBlock(draft, data.me, data.requireSecondApprover, incident.impact);
  const stale = !locked && isStale(draft);
  const when = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '');

  const run = async (key: string, fn: () => Promise<CommsResult>, okKey: string) => {
    if (busy) return;
    setBusy(key);
    setIssues([]);
    try {
      const r = await fn();
      setIssues(r.issues);
      if (r.ok) toast(t(okKey), 'success');
      else toast(errorText(r, t), 'error');
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const counter = (n: number, max: number) => <span className={`text-xs ${n > max ? 'text-danger' : 'text-text-secondary'}`}>{t('draft.chars', { count: n, max })}</span>;

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0" aria-label={t(`state.${draft.state}`)}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border border-border px-2 py-0.5 font-medium text-text-primary">{t(`state.${draft.state}`)}</span>
        <span className="text-text-secondary">{t(`phase.${draft.phase}`)} · {t(`severity.${draft.severity}`)} · {t(`audience.${draft.audience}`)}</span>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor={`sp-${draft.id}`} className="text-xs font-medium text-text-secondary">{t('draft.statusPost')}</label>
          {counter(post.length, LIMITS.statusPost)}
        </div>
        <textarea id={`sp-${draft.id}`} rows={3} className={TEXTAREA} value={post} disabled={locked} onChange={(e) => setPost(e.target.value)} />
      </div>

      {withEmail && (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor={`es-${draft.id}`} className="text-xs font-medium text-text-secondary">{t('draft.emailSubject')}</label>
              {counter(subject.length, LIMITS.emailSubject)}
            </div>
            <input id={`es-${draft.id}`} className={`${TEXTAREA} min-h-[44px]`} value={subject} disabled={locked} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor={`eb-${draft.id}`} className="text-xs font-medium text-text-secondary">{t('draft.emailBody')}</label>
              {counter(body.length, LIMITS.emailBody)}
            </div>
            <textarea id={`eb-${draft.id}`} rows={9} className={TEXTAREA} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
          </div>
        </>
      )}

      {draft.nextUpdateAt && draft.phase !== 'resolved' && <p className="text-xs text-text-secondary">{t('draft.nextUpdate', { time: when(draft.nextUpdateAt) })}</p>}
      {stale && <p role="alert" className="text-sm text-danger">{t('draft.stale')}</p>}
      {draft.statusPostedAt && <p className="text-xs text-text-secondary">{t('draft.postedAt', { time: when(draft.statusPostedAt) })}</p>}
      {draft.emailResult && <p className="text-xs text-text-secondary">{t('draft.emailResult', draft.emailResult)}</p>}
      {draft.state === 'send_failed' && <p role="alert" className="text-sm text-danger">{t('draft.partial')}</p>}
      {draft.rejectReason && <p className="text-xs text-text-secondary">{draft.rejectReason}</p>}
      <Issues issues={issues} />

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {dirty && (
            <Button type="button" variant="secondary" loading={busy === 'save'} onClick={() => void run('save', () => updateDraft(draft.id, { statusPost: post, emailSubject: withEmail ? subject : null, emailBody: withEmail ? body : null }), 'draft.saved')}>
              {t('draft.save')}
            </Button>
          )}
          {!dirty && draft.state === 'draft' && (
            <Button type="button" loading={busy === 'submit'} onClick={() => void run('submit', () => submitDraft(draft.id), 'draft.submitted')}>{t('draft.submit')}</Button>
          )}
        </div>
      )}

      {!dirty && draft.state === 'pending_approval' && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-3">
          {block === 'second_person' ? (
            <p className="text-sm text-text-secondary">{t('draft.secondPerson')}</p>
          ) : (
            <>
              <Checkbox label={t('draft.reviewed')} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!reviewed} loading={busy === 'approve'} onClick={() => void run('approve', () => approveDraft(draft.id, draft.contentHash), 'draft.approved')}>{t('draft.approve')}</Button>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <Input label={t('draft.rejectReason')} maxLength={300} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            </div>
            <Button type="button" variant="secondary" loading={busy === 'reject'} onClick={() => void run('reject', () => rejectDraft(draft.id, rejectReason), 'draft.rejected')}>{t('draft.reject')}</Button>
          </div>
        </div>
      )}

      {!dirty && canSend(draft.state) && (
        <div className="space-y-2 rounded-xl border border-border bg-bg-secondary p-3">
          <p className="text-sm text-text-secondary">{t('draft.sendConfirm')}</p>
          <Button type="button" variant="danger" disabled={stale} loading={busy === 'send'} onClick={() => void run('send', () => sendDraft(draft.id), 'draft.sent')}>
            {draft.state === 'send_failed' ? t('draft.retry') : t('draft.send')}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function StaffIncidentCommsPage() {
  const { t } = useIncidentCommsT();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchOverview();
      setLoad({ kind: 'ready', data });
      setSelected((cur) => cur ?? data.incidents[0]?.id ?? null);
    } catch {
      setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const incident = useMemo(() => (load.kind === 'ready' ? load.data.incidents.find((i) => i.id === selected) ?? null : null), [load, selected]);

  let body: React.ReactNode;
  if (load.kind === 'loading') {
    body = <SkeletonCardList count={3} rows={3} />;
  } else if (load.kind === 'error') {
    body = <EmptyStateError icon={WifiOff} title={t('loadError')} onRetry={() => { setLoad({ kind: 'loading' }); void refresh(); }} />;
  } else if (load.data.incidents.length === 0) {
    body = <EmptyState icon={WifiOff} title={t('noIncidents')} />;
  } else {
    const data = load.data;
    const drafts = data.drafts.filter((d) => d.incidentId === selected);
    body = (
      <div className="space-y-6">
        <Checkbox
          label={t('settings.requireSecond')}
          helperText={t('settings.requireSecondHelp')}
          checked={data.requireSecondApprover}
          onChange={(e) => {
            void saveRequireSecondApprover(e.target.checked)
              .then(() => { toast(t('settings.saved'), 'success'); return refresh(); })
              .catch(() => toast(t('settings.saveError'), 'error'));
          }}
        />

        <section aria-labelledby="ic-incidents">
          <h2 id="ic-incidents" className="mb-2 text-base font-semibold text-text-primary">{t('incidents')}</h2>
          <ul className="space-y-2">
            {data.incidents.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  aria-pressed={i.id === selected}
                  onClick={() => setSelected(i.id)}
                  className={`focus-ring min-h-[44px] w-full rounded-xl border p-3 text-start ${i.id === selected ? 'border-accent bg-accent/10' : 'border-border bg-bg-secondary'}`}
                >
                  <span className="block text-sm font-semibold text-text-primary">{i.title}</span>
                  <span className="mt-0.5 block text-xs text-text-secondary">{t(`impact.${i.impact}`)} · {t(`status.${i.status}`, { defaultValue: i.status })}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {!incident ? (
          <p className="text-sm text-text-secondary">{t('selectIncident')}</p>
        ) : (
          <>
            <NewDraftForm key={incident.id} incident={incident} onCreated={() => void refresh()} />
            <section aria-labelledby="ic-drafts" className="space-y-3">
              <h2 id="ic-drafts" className="text-base font-semibold text-text-primary">{t('draft.heading')}</h2>
              {drafts.length === 0 ? (
                <EmptyState compact title={t('draft.empty')} />
              ) : (
                drafts.map((d) => <DraftCard key={d.id} draft={d} incident={incident} data={data} onChanged={() => void refresh()} />)
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
      <p className="mb-6 mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
      {body}
    </main>
  );
}
