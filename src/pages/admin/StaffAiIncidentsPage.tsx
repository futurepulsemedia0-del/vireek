// /staff/ai-incidents — register of AI incidents (Vireek employees only).
// Data: `ai_incidents` table. Access is enforced by RLS (is_vireek_staff); the route sits behind <StaffRoute>.
// Policy: docs/compliance/policies/ai-incident-response.md. No personal data belongs in this register.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Pill, SelectField, Stat, formatDateTime, type Tone } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { useAiIncidentsT } from '@/i18n/aiIncidentsNamespace';
import {
  AI_INCIDENT_OWNER_ROLES, AI_INCIDENT_SEVERITIES, AI_INCIDENT_SOURCES, AI_INCIDENT_STATUSES, AI_INCIDENT_TYPES, AI_NOTIFICATION_STATES,
  LIMITS, TYPE_DEFAULTS, closeBlockedReason, emptyDraft, filterIncidents, hasErrors, sortIncidents, summariseIncidents, validateDraft,
  type AiIncident, type AiIncidentDraft, type AiIncidentOwnerRole, type AiIncidentSeverity, type AiIncidentSource, type AiIncidentStatus,
  type AiIncidentType, type AiNotificationState, type DraftErrors, type FieldErrorKey, type SeverityFilter, type StatusFilter,
} from '@/lib/aiIncidents';
import { AiIncidentsApiError, createAiIncident, listAiIncidents, updateAiIncident, type AiIncidentsErrorKind } from '@/lib/aiIncidentsApi';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({ title: 'AI incidents — Staff', description: 'Internal: AI incident register.', canonical: 'https://vireek.com/staff/ai-incidents' });
  return null;
}

const SEVERITY_TONE: Record<AiIncidentSeverity, Tone> = { low: 'neutral', medium: 'info', high: 'warning', critical: 'danger' };
const STATUS_TONE: Record<AiIncidentStatus, Tone> = { open: 'warning', investigating: 'warning', contained: 'info', resolved: 'success', closed: 'neutral' };

const errorKind = (e: unknown): AiIncidentsErrorKind => (e instanceof AiIncidentsApiError ? e.kind : 'generic');

type LoadState = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; kind: AiIncidentsErrorKind };

// ----------------------------------------------------------------------------- create form

function CreateForm({ onCreated, onCancel }: { onCreated: (i: AiIncident) => void; onCancel: () => void }) {
  const { t } = useAiIncidentsT();
  const { toast } = useToast();
  const [draft, setDraft] = useState<AiIncidentDraft>(emptyDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const errors: DraftErrors = useMemo(() => validateDraft(draft), [draft]);
  const shown: DraftErrors = showErrors ? errors : {};
  const msg = (k?: FieldErrorKey) => (k ? t(`errors.${k}`) : undefined);
  const set = <K extends keyof AiIncidentDraft>(key: K, value: AiIncidentDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const onTypeChange = (incidentType: AiIncidentType) =>
    setDraft((d) => ({ ...d, incidentType, severity: TYPE_DEFAULTS[incidentType].severity, ownerRole: TYPE_DEFAULTS[incidentType].ownerRole }));

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (saving) return;
    setShowErrors(true);
    if (hasErrors(validateDraft(draft))) return;
    setSaving(true);
    try {
      const created = await createAiIncident(draft);
      toast(t('toast.created', { ref: created.ref }), 'success');
      onCreated(created);
    } catch (err) {
      toast(t(`errors.${errorKind(err)}`), 'error');
      setSaving(false);
    }
  };

  return (
    <Card interactive={false} className="p-4 sm:p-5">
      <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby="ai-incident-form-heading" className="space-y-4">
        <h2 id="ai-incident-form-heading" className="text-lg font-semibold text-text-primary">{t('form.heading')}</h2>
        <Input label={t('form.title')} value={draft.title} maxLength={LIMITS.titleMax} required
          onChange={(e) => set('title', e.target.value)} error={msg(shown.title)} />
        <Textarea label={t('form.summary')} helperText={t('form.summaryHelp')} rows={5} value={draft.summary} maxLength={LIMITS.summaryMax} required
          onChange={(e) => set('summary', e.target.value)} error={msg(shown.summary)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label={t('form.type')} value={draft.incidentType} onChange={(e) => onTypeChange(e.target.value as AiIncidentType)}>
            {AI_INCIDENT_TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('form.severity')} value={draft.severity} onChange={(e) => set('severity', e.target.value as AiIncidentSeverity)}>
            {AI_INCIDENT_SEVERITIES.map((v) => <option key={v} value={v}>{t(`severities.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('form.owner')} value={draft.ownerRole} onChange={(e) => set('ownerRole', e.target.value as AiIncidentOwnerRole)}>
            {AI_INCIDENT_OWNER_ROLES.map((v) => <option key={v} value={v}>{t(`roles.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('form.source')} value={draft.source} onChange={(e) => set('source', e.target.value as AiIncidentSource)}>
            {AI_INCIDENT_SOURCES.map((v) => <option key={v} value={v}>{t(`sources.${v}`)}</option>)}
          </SelectField>
          <Input label={t('form.callId')} value={draft.callId} maxLength={LIMITS.callIdMax} autoComplete="off"
            onChange={(e) => set('callId', e.target.value)} error={msg(shown.callId)} />
          <Input label={t('form.detectedAt')} type="datetime-local" value={draft.detectedAt}
            onChange={(e) => set('detectedAt', e.target.value)} error={msg(shown.detectedAt)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={saving} loadingLabel={t('form.submitting')}>{t('form.submit')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('form.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

// ----------------------------------------------------------------------------- one incident

function IncidentCard({ incident, onUpdated }: { incident: AiIncident; onUpdated: (i: AiIncident) => void }) {
  const { t } = useAiIncidentsT();
  const { toast } = useToast();
  const [status, setStatus] = useState<AiIncidentStatus>(incident.status);
  const [customer, setCustomer] = useState<AiNotificationState>(incident.customerNotification);
  const [regulator, setRegulator] = useState<AiNotificationState>(incident.regulatorNotification);
  const [postmortem, setPostmortem] = useState(incident.postmortemRef ?? '');
  const [saving, setSaving] = useState(false);

  // Re-sync when the saved row changes (after a save or a refresh).
  useEffect(() => {
    setStatus(incident.status);
    setCustomer(incident.customerNotification);
    setRegulator(incident.regulatorNotification);
    setPostmortem(incident.postmortemRef ?? '');
  }, [incident]);

  const dirty = status !== incident.status
    || customer !== incident.customerNotification
    || regulator !== incident.regulatorNotification
    || postmortem.trim() !== (incident.postmortemRef ?? '');
  const blocked = closeBlockedReason(incident.severity, status, postmortem) === 'postmortem';
  const headingId = `ai-incident-${incident.id}`;

  const save = async () => {
    if (!dirty || blocked || saving) return;
    setSaving(true);
    try {
      const updated = await updateAiIncident(incident.id, {
        status, customerNotification: customer, regulatorNotification: regulator, postmortemRef: postmortem.trim() || null,
      });
      toast(t('toast.updated', { ref: updated.ref }), 'success');
      onUpdated(updated);
    } catch (err) {
      toast(t(`errors.${errorKind(err)}`), 'error');
    }
    setSaving(false);
  };

  return (
    <li aria-labelledby={headingId}>
      <Card interactive={false} className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-text-secondary">{incident.ref}</span>
          <Pill tone={SEVERITY_TONE[incident.severity]}>{t(`severities.${incident.severity}`)}</Pill>
          <Pill tone={STATUS_TONE[incident.status]}>{t(`statuses.${incident.status}`)}</Pill>
          <Pill tone="neutral">{t(`types.${incident.incidentType}`)}</Pill>
        </div>
        <h3 id={headingId} className="text-base font-semibold text-text-primary">{incident.title}</h3>
        <p className="whitespace-pre-wrap text-sm text-text-secondary">{incident.summary}</p>
        <dl className="grid gap-x-6 gap-y-1 text-xs text-text-secondary sm:grid-cols-3">
          <div><dt className="inline">{t('row.detected')}: </dt><dd className="inline text-text-primary">{formatDateTime(incident.detectedAt)}</dd></div>
          <div><dt className="inline">{t('row.owner')}: </dt><dd className="inline text-text-primary">{t(`roles.${incident.ownerRole}`)}</dd></div>
          {incident.callId && <div><dt className="inline">{t('row.call')}: </dt><dd className="inline font-mono text-text-primary">{incident.callId}</dd></div>}
        </dl>
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label={t('row.status')} value={status} onChange={(e) => setStatus(e.target.value as AiIncidentStatus)}>
            {AI_INCIDENT_STATUSES.map((v) => <option key={v} value={v}>{t(`statuses.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('row.customerNotification')} value={customer} onChange={(e) => setCustomer(e.target.value as AiNotificationState)}>
            {AI_NOTIFICATION_STATES.map((v) => <option key={v} value={v}>{t(`notice.${v}`)}</option>)}
          </SelectField>
          <SelectField label={t('row.regulatorNotification')} value={regulator} onChange={(e) => setRegulator(e.target.value as AiNotificationState)}>
            {AI_NOTIFICATION_STATES.map((v) => <option key={v} value={v}>{t(`notice.${v}`)}</option>)}
          </SelectField>
        </div>
        <p className="text-xs text-text-secondary">{t('row.notificationHelp')}</p>
        <Input label={t('row.postmortemRef')} helperText={t('row.postmortemHelp')} value={postmortem} maxLength={LIMITS.postmortemMax} autoComplete="off"
          onChange={(e) => setPostmortem(e.target.value)} error={blocked ? t('errors.postmortemRequired') : undefined} />
        <Button size="sm" onClick={() => void save()} loading={saving} loadingLabel={t('row.saving')} disabled={!dirty || blocked}>{t('row.save')}</Button>
      </Card>
    </li>
  );
}

// ----------------------------------------------------------------------------- page

export function StaffAiIncidentsPage() {
  const { t } = useAiIncidentsT();
  const [rows, setRows] = useState<AiIncident[]>([]);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [severity, setSeverity] = useState<SeverityFilter>('all');

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setRows(await listAiIncidents());
      setState({ phase: 'ready' });
    } catch (err) {
      setState({ phase: 'error', kind: errorKind(err) });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summariseIncidents(rows), [rows]);
  const visible = useMemo(() => sortIncidents(filterIncidents(rows, status, severity)), [rows, status, severity]);

  const onCreated = (i: AiIncident) => { setCreating(false); setRows((r) => [i, ...r]); };
  const onUpdated = (i: AiIncident) => setRows((r) => r.map((x) => (x.id === i.id ? i : x)));
  const clearFilters = () => { setStatus('all'); setSeverity('all'); };

  return (
    <>
      <SEO />
      <Header />
      <main id="main-content" className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('subtitle')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void load()} disabled={state.phase === 'loading'}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />{t('refresh')}
              </Button>
              <Button onClick={() => setCreating(true)} disabled={creating || state.phase === 'error'}>
                <Plus className="h-4 w-4" aria-hidden="true" />{t('report')}
              </Button>
            </div>
          </div>

          <p role="note" className="rounded-xl border border-warning/30 bg-warning-subtle p-3 text-sm text-text-primary">{t('privacy')}</p>

          {creating && <CreateForm onCreated={onCreated} onCancel={() => setCreating(false)} />}

          {state.phase === 'loading' && (
            <div>
              <p role="status" className="sr-only">{t('loading')}</p>
              <SkeletonCardList count={3} rows={3} />
            </div>
          )}

          {state.phase === 'error' && (
            state.kind === 'forbidden'
              ? <EmptyState variant="no-permission" title={t('forbidden')} />
              : <EmptyState variant="load-failed" title={t('loadError')} onRetry={() => void load()} />
          )}

          {state.phase === 'ready' && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label={t('stats.active')} value={summary.active} />
                <Stat label={t('stats.critical')} value={summary.critical} tone={summary.critical > 0 ? 'danger' : 'neutral'} />
                <Stat label={t('stats.awaitingNotification')} value={summary.awaitingNotification} tone={summary.awaitingNotification > 0 ? 'warning' : 'neutral'} />
              </div>

              <div className="grid gap-3 sm:max-w-xl sm:grid-cols-2">
                <SelectField label={t('filters.status')} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  <option value="active">{t('filters.active')}</option>
                  <option value="all">{t('filters.all')}</option>
                  {AI_INCIDENT_STATUSES.map((v) => <option key={v} value={v}>{t(`statuses.${v}`)}</option>)}
                </SelectField>
                <SelectField label={t('filters.severity')} value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)}>
                  <option value="all">{t('filters.all')}</option>
                  {AI_INCIDENT_SEVERITIES.map((v) => <option key={v} value={v}>{t(`severities.${v}`)}</option>)}
                </SelectField>
              </div>

              {rows.length === 0 ? (
                <EmptyState variant="no-data" title={t('empty.title')} description={t('empty.description')}
                  action={{ label: t('report'), onClick: () => setCreating(true) }} />
              ) : visible.length === 0 ? (
                <EmptyState variant="no-results" title={t('empty.filteredTitle')} description={t('empty.filteredDescription')} onClearFilters={clearFilters} />
              ) : (
                <ul className="space-y-3">
                  {visible.map((i) => <IncidentCard key={i.id} incident={i} onUpdated={onUpdated} />)}
                </ul>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
