import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, MapPin, MessageSquare, ShieldAlert, UserMinus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { fieldBase, fieldBorder } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { MASS_INCIDENT_NS } from '@/i18n/massIncidentNamespace';
import {
  MassIncidentError,
  broadcast,
  confirmCause,
  detachContact,
  isOpenStatus,
  maskPhone,
  setIncidentStatus,
  type BroadcastPreview,
  type ContactRow,
  type IncidentRow,
  type SuspectedCause,
} from '@/lib/massIncident';

const CAUSES: SuspectedCause[] = ['water_supply_issue', 'power_grid_outage', 'gas_utility_issue', 'severe_weather', 'sewer_main_issue', 'extreme_temperature'];
const BREAKDOWN_KEYS = ['count', 'agreement', 'tightness', 'burst', 'corroboration'] as const;

interface Props {
  incident: IncidentRow;
  contacts: ContactRow[];
  contactsLoading: boolean;
  canManage: boolean;
  onChanged: () => void;
}

export function StatusBadge({ status }: { status: IncidentRow['status'] }) {
  const { t } = useTranslation(MASS_INCIDENT_NS);
  const tone =
    status === 'active' ? 'border-warning-500/40 bg-warning-500/10 text-text-primary'
    : status === 'resolved' || status === 'dismissed' ? 'border-border bg-bg-tertiary text-text-secondary'
    : 'border-accent/30 bg-accent/10 text-text-primary';
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>{t(`status_${status}`)}</span>;
}

export function IncidentDetail({ incident, contacts, contactsLoading, canManage, onChanged }: Props) {
  const { t, i18n } = useTranslation(MASS_INCIDENT_NS);
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<'resolved' | 'dismissed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [causeChoice, setCauseChoice] = useState<SuspectedCause>(incident.suspected_cause === 'unknown' ? 'water_supply_issue' : incident.suspected_cause);
  const [preview, setPreview] = useState<(BroadcastPreview & { kind: 'update' | 'resolved' }) | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const fmt = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' });
  const open = isOpenStatus(incident.status);
  const truckRollCandidates = contacts.filter((c) => c.job_id && c.triage_decision === 'upstream_likely').length;

  const errText = (e: unknown): string => {
    if (e instanceof MassIncidentError) {
      if (e.code === 'forbidden') return t('forbidden');
      if (e.code === 'rate_limited') return t('rateLimited');
      if (e.message === 'confidence_too_low_to_message_customers') return t('tooLow');
    }
    return t('genericError');
  };

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      onChanged();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const scope = incident.scope;
  const scopeText =
    scope.postalCodes.length > 0 && scope.radiusMiles == null ? t('scopePostal', { codes: scope.postalCodes.join(', ') })
    : scope.radiusMiles != null ? t('scopeRadius', { miles: scope.radiusMiles.toFixed(1) })
    : t('scopeNone');

  const loadPreview = async (kind: 'update' | 'resolved') => {
    setBusy(true);
    try {
      const p = await broadcast(incident.id, kind, true);
      setPreview({ ...p, kind });
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!preview) return;
    setSendOpen(false);
    await run(async () => {
      const r = await broadcast(incident.id, preview.kind, false);
      toast(t('sent', { sent: r.sent, deferred: r.deferred, skipped: r.skipped }), 'success');
      setPreview(null);
    });
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="space-y-4 border-b border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-text-primary">{incident.title}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-text-secondary">
              <MapPin size={14} aria-hidden="true" />
              {scopeText}
            </p>
          </div>
          <StatusBadge status={incident.status} />
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-secondary">{t('confidence')}</dt>
            <dd className="font-semibold tabular-nums text-text-primary">{Math.round(incident.confidence * 100)}%</dd>
          </div>
          <div>
            <dt className="text-text-secondary">{t('firstContact')}</dt>
            <dd className="text-text-primary">{fmt(incident.first_contact_at)}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">{t('lastContact')}</dt>
            <dd className="text-text-primary">{fmt(incident.last_contact_at)}</dd>
          </div>
        </dl>
        <p className="text-xs text-text-secondary">{t('confidenceHelp')}</p>

        <details className="rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
          <summary className="focus-ring cursor-pointer rounded font-medium text-text-primary">{t('breakdown')}</summary>
          <ul className="mt-2 space-y-1.5">
            {BREAKDOWN_KEYS.map((k) => {
              const v = Number(incident.confidence_breakdown?.[k] ?? 0);
              return (
                <li key={k} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 text-text-secondary">{t(`b_${k}`)}</span>
                  <span className="h-2 flex-1 rounded-full bg-bg-tertiary" role="img" aria-label={`${t(`b_${k}`)}: ${Math.round(v * 100)}%`}>
                    <span className="block h-2 rounded-full bg-accent" style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }} />
                  </span>
                  <span className="w-10 text-end tabular-nums text-text-primary">{Math.round(v * 100)}%</span>
                </li>
              );
            })}
          </ul>
        </details>

        <section aria-labelledby="cause-h" className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
          <h3 id="cause-h" className="font-medium text-text-primary">{t('suspectedCause')}</h3>
          <p className="mt-1 text-text-primary">
            {t(`cause_${incident.suspected_cause}`)} · <span className="text-text-secondary">{t(`causeStatus_${incident.cause_status}`)}</span>
          </p>
          <p className="mt-2 text-text-secondary"><span className="font-medium text-text-primary">{t('uncertainty')}: </span>{incident.cause_uncertainty}</p>
          {incident.alternatives.length > 0 && (
            <p className="mt-2 text-text-secondary">
              <span className="font-medium text-text-primary">{t('alternatives')}: </span>
              {incident.alternatives.map((a) => `${t(`cause_${a.cause}`)} (${Math.round(a.confidence * 100)}%)`).join(', ')}
            </p>
          )}
          {canManage && open && incident.cause_status !== 'owner_confirmed' && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-48">
                <label htmlFor="cause-choice" className="mb-1 block text-xs text-text-secondary">{t('confirmCauseHint')}</label>
                <select id="cause-choice" className={`${fieldBase} ${fieldBorder(false)}`} value={causeChoice} onChange={(e) => setCauseChoice(e.target.value as SuspectedCause)}>
                  {CAUSES.map((c) => <option key={c} value={c}>{t(`cause_${c}`)}</option>)}
                </select>
              </div>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => confirmCause(incident.id, causeChoice), t('statusSaved'))}>{t('confirmCause')}</Button>
            </div>
          )}
        </section>

        {incident.emergency_count > 0 && (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-text-primary">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {t('emergencies', { count: incident.emergency_count })}
          </p>
        )}

        {truckRollCandidates > 0 && (
          <p role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-sm text-text-primary">{t('truckRollNote', { count: truckRollCandidates })}</p>
        )}

        {canManage && (
          <div className="flex flex-wrap gap-2">
            {incident.status === 'active' && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => setIncidentStatus(incident.id, 'monitoring'), t('statusSaved'))}>{t('markMonitoring')}</Button>}
            {incident.status === 'monitoring' && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => setIncidentStatus(incident.id, 'active'), t('statusSaved'))}>{t('markActive')}</Button>}
            {open && <Button type="button" size="sm" disabled={busy} onClick={() => setConfirm('resolved')}>{t('resolve')}</Button>}
            {open && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm('dismissed')}>{t('dismiss')}</Button>}
          </div>
        )}
      </div>

      {canManage && (incident.status === 'active' || incident.status === 'monitoring' || incident.status === 'resolved') && (
        <section aria-labelledby="msg-h" className="space-y-3 border-b border-border p-4">
          <h3 id="msg-h" className="flex items-center gap-2 text-sm font-semibold text-text-primary"><MessageSquare size={15} aria-hidden="true" />{t('customers')}</h3>
          <p className="text-xs text-text-secondary">{t('customersHelp')}</p>
          <div className="flex flex-wrap gap-2">
            {incident.status !== 'resolved' && <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void loadPreview('update')}>{t('previewBtn')}</Button>}
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void loadPreview('resolved')}>{t('sendResolvedBtn')}</Button>
          </div>
          {preview && (
            <div className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
              <p className="font-medium text-text-primary">{t('previewTitle')}</p>
              <p className="mt-1 whitespace-pre-wrap text-text-primary" dir="auto">{preview.preview}</p>
              <p className="mt-2 text-text-secondary">{preview.eligible > 0 ? t('previewRecipients', { count: preview.eligible }) : t('previewNone')}</p>
              {preview.eligible > 0 && <Button type="button" size="sm" className="mt-3" disabled={busy} onClick={() => setSendOpen(true)}>{t('sendBtn', { count: preview.eligible })}</Button>}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="members-h" className="p-4">
        <h3 id="members-h" className="mb-2 text-sm font-semibold text-text-primary">{t('members')} ({incident.member_count})</h3>
        {contactsLoading ? (
          <p role="status" className="text-sm text-text-secondary">{t('loading')}</p>
        ) : (
          <ContactList contacts={contacts} canManage={canManage && open} onDetach={(id) => void run(() => detachContact(id), t('detachDone'))} busy={busy} />
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'dismissed' ? t('dismissTitle') : t('resolveTitle')}
        description={confirm === 'dismissed' ? t('dismissBody') : t('resolveBody')}
        confirmLabel={confirm === 'dismissed' ? t('dismiss') : t('resolve')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const status = confirm;
          setConfirm(null);
          if (status) void run(() => setIncidentStatus(incident.id, status), t('statusSaved'));
        }}
      />
      <ConfirmDialog
        open={sendOpen}
        title={t('sendConfirmTitle')}
        description={t('sendConfirmBody', { count: preview?.eligible ?? 0 })}
        confirmLabel={t('sendBtn', { count: preview?.eligible ?? 0 })}
        onCancel={() => setSendOpen(false)}
        onConfirm={() => void send()}
      />
    </div>
  );
}

export function ContactList({ contacts, canManage, onDetach, busy }: { contacts: ContactRow[]; canManage: boolean; onDetach?: (id: string) => void; busy?: boolean }) {
  const { t, i18n } = useTranslation(MASS_INCIDENT_NS);
  return (
    <ul className="space-y-2">
      {contacts.map((c) => {
        const emergency = c.is_emergency || c.hazards.length > 0;
        return (
          <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-text-secondary">
                {new Date(c.contact_at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })} · {t(`source_${c.source}`)}
                {c.postal_code ? ` · ${c.postal_code}` : ''} · <span dir="ltr" className="tabular-nums">{maskPhone(c.contact_phone)}</span>
              </p>
              {c.job_id && <span className="inline-flex rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary">{t('bookedTag')}</span>}
              {emergency && (
                <span className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-xs font-medium text-text-primary">
                  <AlertTriangle size={12} aria-hidden="true" />{t('emergencyTag')}
                </span>
              )}
            </div>
            {c.symptom_text && <p className="mt-1 text-text-primary" dir="auto">{c.symptom_text}</p>}
            <p className="mt-1 text-xs text-text-secondary">{t('contactDecision')}: {t(`decision_${c.triage_decision ?? 'none'}`)}</p>
            {canManage && onDetach && !emergency && (
              <Button type="button" size="sm" variant="ghost" className="mt-2" disabled={busy} onClick={() => onDetach(c.id)}>
                <UserMinus size={14} aria-hidden="true" />{t('detach')}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
