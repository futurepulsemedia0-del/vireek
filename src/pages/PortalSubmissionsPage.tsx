import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { usePortalT } from '@/i18n/portalSubmissionNamespace';
import {
  PORTAL_TYPES, PortalError, approveRun, assistedConfirm, assistedPrepare, cancelSubmission, credentialsMeta, credentialsPut, evidenceUrl, ingestRemittance,
  loadEvents, loadEvidence, loadProfiles, loadRemittanceLines, loadRemittances, loadSettings, loadStats, loadSubmissions, recordStatus, retrySubmission, rpc,
  sendEmail, usePortalData, DEFAULT_SETTINGS,
  type AccountSettings, type AssistedPrep, type LoadState, type PortalChannel, type PortalType, type ProfileRow, type SubmissionRow,
} from '@/lib/portalApi';

type Tab = 'console' | 'profiles' | 'remittances' | 'settings';
type TFn = ReturnType<typeof usePortalT>['t'];
const TABS: readonly Tab[] = ['console', 'profiles', 'remittances', 'settings'];
const ATTENTION = new Set(['failed', 'rejected', 'awaiting_human']);
const EMPTY_CONFIG = JSON.stringify({ required_fields: [], checklist: [], status_map: {} }, null, 2);

function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}
const errKey = (e: unknown): string => (e instanceof PortalError ? e.code : 'generic');
const fmt = (iso: string, lang: string) => new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
const money = (c: number, lang: string) => (c / 100).toLocaleString(lang, { style: 'currency', currency: 'USD' });

function Panel<T>({ state, empty, t, children }: { state: LoadState<T[]>; empty: string; t: TFn; children: (rows: T[]) => ReactNode }) {
  if (state.loading) return <div className="space-y-2" role="status" aria-busy="true"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>;
  if (state.error) return <div role="alert" className="space-y-2 text-sm"><p className="text-text-primary">{t('page.loadFailed')}</p><Button size="sm" variant="secondary" onClick={state.reload}>{t('page.retry')}</Button></div>;
  if (!state.data || state.data.length === 0) return <p className="text-sm text-text-secondary">{empty}</p>;
  return <>{children(state.data)}</>;
}

function StateBadge({ s, t }: { s: string; t: TFn }) {
  const tone = s === 'rejected' || s === 'failed' ? 'text-danger' : s === 'paid' || s === 'approved' ? 'text-success' : s === 'awaiting_human' ? 'text-warning' : 'text-text-secondary';
  // text label always present: colour is never the only signal (WCAG 1.4.1)
  return <span className={`inline-flex items-center rounded-control border border-border px-2 py-0.5 text-xs font-medium ${tone}`}>{t(`state.${s}`)}</span>;
}

// ------------------------------------------------------------------ submission detail ----------------------------------------------------
function Detail({ sub, t, lang, onClose, onChanged }: { sub: SubmissionRow; t: TFn; lang: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const headId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState<AssistedPrep | null>(null);
  const [ref, setRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [raw, setRaw] = useState('');
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const events = usePortalData(() => loadEvents(sub.id), [sub.id, sub.state]);
  const evidence = usePortalData(() => loadEvidence(sub.id), [sub.id, sub.state]);

  useEffect(() => { closeRef.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, 'success'); onChanged(); } catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  const actor = (k: string) => t(`detail.actor${k.charAt(0).toUpperCase()}${k.slice(1)}`);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={headId} className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="h-full w-full max-w-xl overflow-y-auto bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id={headId} className="text-lg font-semibold text-text-primary">{t('detail.title')}</h2><p className="text-sm text-text-secondary">{t('console.packet', { n: sub.packet_version })} · {t(`channel.${sub.channel}`)}</p></div>
          <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose}>{t('detail.close')}</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><StateBadge s={sub.state} t={t} />{sub.external_ref && <span className="text-sm text-text-secondary" dir="ltr">{t('console.reference')}: {sub.external_ref}</span>}</div>
        {sub.state === 'rejected' && sub.rejection_reason && <p role="alert" className="mt-3 rounded-control border border-border p-3 text-sm text-danger">{sub.rejection_reason}</p>}
        {sub.state === 'failed' && <p role="alert" className="mt-3 text-sm text-danger">{t('console.triageFailed', { code: sub.failure_code ?? '—' })}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {sub.state === 'prepared' && sub.channel === 'email' && <Button loading={busy} loadingLabel={t('actions.working')} onClick={() => run(() => sendEmail(sub.id))}>{t('actions.sendEmail')}</Button>}
          {sub.state === 'prepared' && sub.channel === 'assisted' && <Button loading={busy} onClick={() => run(async () => setPrep(await assistedPrepare(sub.id)))}>{t('actions.prepareAssisted')}</Button>}
          {sub.state === 'awaiting_human' && sub.channel === 'automation' && <Button loading={busy} onClick={() => run(() => approveRun(sub.id))}>{t('actions.approveRun')}</Button>}
          {sub.state === 'awaiting_human' && sub.channel === 'assisted' && !prep && <Button variant="secondary" loading={busy} onClick={() => run(async () => setPrep(await assistedPrepare(sub.id)))}>{t('actions.prepareAssisted')}</Button>}
          {sub.state === 'failed' && <Button variant="secondary" loading={busy} onClick={() => run(() => retrySubmission(sub.id))}>{t('actions.retry')}</Button>}
          {['queued', 'prepared', 'awaiting_human'].includes(sub.state) && <Button variant="ghost" loading={busy} onClick={() => run(() => cancelSubmission(sub.id))}>{t('actions.cancel')}</Button>}
        </div>

        {prep && (
          <section className="mt-5 space-y-3" aria-label={t('assisted.title')}>
            <h3 className="font-medium text-text-primary">{t('assisted.title')}</h3>
            <p className="text-sm text-text-secondary">{t('assisted.intro')}</p>
            {prep.deep_link ? <a className="text-sm underline" href={prep.deep_link} target="_blank" rel="noopener noreferrer">{t('assisted.openPortal')}</a> : <p className="text-sm text-text-secondary">{t('assisted.noLink')}</p>}
            {!prep.ready && <p role="alert" className="text-sm text-warning">{t('assisted.notReady')}</p>}
            <ul className="divide-y divide-border rounded-control border border-border">
              {prep.fields.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0"><div className="text-xs text-text-secondary">{f.label}</div><div className="break-words text-sm text-text-primary" dir="auto">{f.missing ? <span className="text-danger">{t('assisted.missing')}</span> : f.value || t('console.none')}</div></div>
                  {!f.missing && <Button size="sm" variant="secondary" aria-label={`${t('assisted.copy')}: ${f.label}`} onClick={() => { void navigator.clipboard?.writeText(f.value); setCopied(f.key); }}>{copied === f.key ? t('assisted.copied') : t('assisted.copy')}</Button>}
                </li>
              ))}
            </ul>
            {prep.checklist.length > 0 && <div><h4 className="text-sm font-medium text-text-primary">{t('assisted.checklist')}</h4><ul className="mt-1 list-disc ps-5 text-sm text-text-secondary">{prep.checklist.map((c) => <li key={c.id}>{c.text}</li>)}</ul></div>}
          </section>
        )}

        {sub.state === 'awaiting_human' && sub.channel === 'assisted' && (
          <section className="mt-5 space-y-3">
            <Input label={t('assisted.reference')} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={200} dir="ltr" />
            <Input label={t('assisted.evidence')} type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button loading={busy} disabled={!ref.trim() && !file} disabledReason={t('errors.reference_or_evidence_required')} onClick={() => run(() => assistedConfirm(sub.id, ref.trim(), file), t('assisted.confirmed'))}>{t('actions.confirm')}</Button>
          </section>
        )}

        {['submitted', 'acknowledged', 'approved', 'scheduled_for_payment'].includes(sub.state) && (
          <section className="mt-5 space-y-3">
            <Input label={t('status.label')} value={raw} onChange={(e) => setRaw(e.target.value)} maxLength={200} />
            <Textarea label={t('status.reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} />
            <Button variant="secondary" loading={busy} disabled={!raw.trim()} onClick={() => run(() => recordStatus(sub.id, raw.trim(), reason.trim() || undefined), t('status.saved'))}>{t('actions.record')}</Button>
          </section>
        )}

        <section className="mt-6"><h3 className="font-medium text-text-primary">{t('detail.evidence')}</h3>
          <Panel state={evidence} empty={t('detail.noEvidence')} t={t}>{(rows) => <ul className="mt-2 space-y-1 text-sm">{rows.map((e) => <li key={e.id} className="flex items-center justify-between"><span className="text-text-secondary">{e.kind} · {fmt(e.created_at, lang)}</span><Button size="sm" variant="link" onClick={() => run(async () => { const u = await evidenceUrl(e.id); if (u.url) window.open(u.url, '_blank', 'noopener,noreferrer'); })}>{t('detail.viewEvidence')}</Button></li>)}</ul>}</Panel></section>
        <section className="mt-6"><h3 className="font-medium text-text-primary">{t('detail.timeline')}</h3>
          <Panel state={events} empty={t('console.none')} t={t}>{(rows) => <ol className="mt-2 space-y-2 border-s border-border ps-4 text-sm">{rows.map((e) => <li key={e.id}><span className="text-text-primary">{e.to_state ? t(`state.${e.to_state}`) : e.event_type}</span><span className="text-text-secondary"> · {actor(e.actor_kind)} · {fmt(e.created_at, lang)}</span></li>)}</ol>}</Panel></section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ console --------------------------------------------------------------
function Console({ t, lang }: { t: TFn; lang: string }) {
  const subs = usePortalData(loadSubmissions);
  const profiles = usePortalData(loadProfiles);
  const [open, setOpen] = useState<SubmissionRow | null>(null);
  const names = new Map((profiles.data ?? []).map((p) => [p.id, p.name]));
  const attention = (subs.data ?? []).filter((s) => ATTENTION.has(s.state) || s.pause_reason);
  const refresh = () => { subs.reload(); setOpen(null); };
  return (
    <div className="space-y-4">
      {attention.length > 0 && (
        <Card padding="md" role="region" aria-label={t('console.triage')}>
          <h2 className="font-medium text-text-primary">{t('console.triage')} ({attention.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">{attention.map((s) => (
            <li key={s.id}><button type="button" className="focus-ring text-start underline" onClick={() => setOpen(s)}>
              {s.state === 'failed' ? t('console.triageFailed', { code: s.failure_code ?? '—' }) : s.state === 'rejected' ? t('console.triageRejected', { reason: s.rejection_reason ?? '' }) : s.pause_reason ? t('console.triagePaused', { reason: s.pause_reason }) : t('console.triageWaiting')}
              {' · '}{names.get(s.profile_id) ?? ''}</button></li>))}</ul>
        </Card>
      )}
      <Card padding="md">
        <Panel state={subs} empty={t('console.empty')} t={t}>{(rows) => (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-start text-text-secondary">{(['portal', 'channel', 'status', 'reference', 'updated'] as const).map((c) => <th key={c} scope="col" className="p-2 text-start font-medium">{t(`console.${c}`)}</th>)}<th scope="col" className="p-2"><span className="sr-only">{t('console.open')}</span></th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="p-2 text-text-primary">{names.get(s.profile_id) ?? t('console.none')}</td><td className="p-2 text-text-secondary">{t(`channel.${s.channel}`)}</td>
                <td className="p-2"><StateBadge s={s.state} t={t} /></td><td className="p-2 text-text-secondary" dir="ltr">{s.external_ref ?? t('console.none')}</td><td className="p-2 text-text-secondary">{fmt(s.state_changed_at, lang)}</td>
                <td className="p-2 text-end"><Button size="sm" variant="secondary" onClick={() => setOpen(s)}>{t('console.open')}</Button></td>
              </tr>))}</tbody></table></div>)}</Panel>
      </Card>
      {open && <Detail sub={open} t={t} lang={lang} onClose={() => setOpen(null)} onChanged={refresh} />}
    </div>
  );
}

// ------------------------------------------------------------------ profiles ------------------------------------------------------------
function ProfileEditor({ t, isOwner, edit, onDone }: { t: TFn; isOwner: boolean; edit: ProfileRow | null; onDone: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({ customer: edit?.customer_id ?? '', name: edit?.name ?? '', type: (edit?.portal_type ?? 'generic') as PortalType, url: edit?.portal_url ?? '', email: edit?.ap_email ?? '', channel: (edit?.channel_preference ?? 'assisted') as Exclude<PortalChannel, 'automation'>, config: EMPTY_CONFIG });
  const [busy, setBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ has_secret: boolean; fields: string[] } | null>(null);
  const [cred, setCred] = useState({ username: '', password: '' });
  const [ack, setAck] = useState(false);
  useEffect(() => { if (edit) void credentialsMeta(edit.id).then(setMeta).catch(() => setMeta(null)); }, [edit]);

  async function save() {
    let cfg: unknown;
    try { cfg = JSON.parse(f.config); setCfgErr(null); } catch { setCfgErr(t('profiles.invalidJson')); return; }
    setBusy(true);
    try {
      const r = await rpc<{ current_version: number }>('portal_save_profile', { p_profile_id: edit?.id ?? null, p_customer_id: f.customer, p_name: f.name, p_portal_type: f.type, p_portal_url: f.url || null, p_ap_email: f.email || null, p_contact: {}, p_channel_preference: f.channel, p_config: cfg });
      toast(t('profiles.saved', { n: r.current_version }), 'success'); onDone();
    } catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  async function saveCred() {
    if (!edit) return;
    setBusy(true);
    try { setMeta(await credentialsPut(edit.id, { username: cred.username, password: cred.password })); setCred({ username: '', password: '' }); toast(t('vault.saved'), 'success'); }
    catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!edit || !window.confirm(t('profiles.disconnectConfirm'))) return;
    try { await rpc('portal_disconnect_profile', { p_profile_id: edit.id }); toast(t('profiles.disconnected'), 'success'); onDone(); } catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); }
  }
  return (
    <Card padding="md" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label={t('profiles.customerId')} value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} dir="ltr" required disabled={!!edit} />
        <Input label={t('profiles.name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} required />
        <Select label={t('profiles.type')} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as PortalType })}>{PORTAL_TYPES.map((p) => <option key={p} value={p}>{t(`profiles.types.${p}`)}</option>)}</Select>
        <Select label={t('profiles.channel')} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as typeof f.channel })}>{(['email', 'assisted', 'api'] as const).map((c) => <option key={c} value={c}>{t(`channel.${c}`)}</option>)}</Select>
        <Input label={t('profiles.url')} type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} dir="ltr" />
        <Input label={t('profiles.email')} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" />
      </div>
      <Textarea label={t('profiles.config')} value={f.config} onChange={(e) => setF({ ...f, config: e.target.value })} rows={8} dir="ltr" error={cfgErr ?? undefined} />
      <div className="flex gap-2"><Button loading={busy} onClick={save} disabled={!f.customer || !f.name}>{t('profiles.save')}</Button><Button variant="ghost" onClick={onDone}>{t('profiles.cancelEdit')}</Button></div>
      {edit && (
        <section className="space-y-3 border-t border-border pt-4" aria-label={t('vault.title')}>
          <h3 className="font-medium text-text-primary">{t('vault.title')}</h3>
          <p className="text-sm text-text-secondary">{t('vault.writeOnly')}</p>
          <p className="text-sm text-text-primary" role="status">{meta?.has_secret ? t('vault.has', { fields: meta.fields.join(', ') }) : t('vault.none')}</p>
          {isOwner ? (<div className="grid gap-3 sm:grid-cols-2">
            <Input label={t('vault.username')} value={cred.username} onChange={(e) => setCred({ ...cred, username: e.target.value })} autoComplete="off" dir="ltr" />
            <Input label={t('vault.password')} type="password" value={cred.password} onChange={(e) => setCred({ ...cred, password: e.target.value })} autoComplete="new-password" dir="ltr" />
            <label className="flex items-start gap-2 text-sm text-text-secondary sm:col-span-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" /><span>{t('consent.check')}</span></label>
            <div className="sm:col-span-2"><Button variant="secondary" loading={busy} disabled={!ack || (!cred.username && !cred.password)} disabledReason={t('consent.check')} onClick={saveCred}>{t('vault.replace')}</Button></div>
          </div>) : <p className="text-sm text-text-secondary">{t('vault.ownerOnly')}</p>}
          {isOwner && <Button variant="danger" size="sm" onClick={disconnect}>{t('profiles.disconnect')}</Button>}
        </section>
      )}
    </Card>
  );
}

function Profiles({ t, lang, isOwner }: { t: TFn; lang: string; isOwner: boolean }) {
  const profiles = usePortalData(loadProfiles);
  const stats = usePortalData(loadStats);
  const [edit, setEdit] = useState<ProfileRow | 'new' | null>(null);
  if (edit) return <ProfileEditor t={t} isOwner={isOwner} edit={edit === 'new' ? null : edit} onDone={() => { setEdit(null); profiles.reload(); stats.reload(); }} />;
  const stat = new Map((stats.data ?? []).map((s) => [s.profile_id, s]));
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => setEdit('new')}>{t('profiles.add')}</Button></div>
      <Panel state={profiles} empty={t('profiles.empty')} t={t}>{(rows) => (
        <ul className="space-y-3">{rows.map((p) => { const s = stat.get(p.id); return (
          <li key={p.id}><Card padding="md" className="space-y-2">
            <div className="flex items-center justify-between gap-3"><div><div className="font-medium text-text-primary">{p.name}</div><div className="text-sm text-text-secondary">{t(`profiles.types.${p.portal_type}`)} · {t(`channel.${p.channel_preference}`)} · {t('profiles.version', { n: p.current_version })}</div></div><Button size="sm" variant="secondary" onClick={() => setEdit(p)}>{t('profiles.edit')}</Button></div>
            <dl className="grid grid-cols-3 gap-2 text-sm"><div><dt className="text-text-secondary">{t('profiles.statsRate')}</dt><dd className="text-text-primary">{s?.success_rate != null ? `${s.success_rate.toLocaleString(lang)}%` : t('profiles.statsNoData')}</dd></div>
              <div><dt className="text-text-secondary">{t('profiles.statsMedian')}</dt><dd className="text-text-primary">{s?.median_time_to_submit_seconds != null ? `${Math.round(s.median_time_to_submit_seconds / 60).toLocaleString(lang)} min` : t('console.none')}</dd></div>
              <div><dt className="text-text-secondary">{t('profiles.statsDrift')}</dt><dd className={s && s.drift_runs > 0 ? 'text-danger' : 'text-text-primary'}>{(s?.drift_runs ?? 0).toLocaleString(lang)}</dd></div></dl>
          </Card></li>); })}</ul>)}</Panel>
    </div>
  );
}

// ------------------------------------------------------------------ remittances ---------------------------------------------------------
function Remittances({ t, lang }: { t: TFn; lang: string }) {
  const { toast } = useToast();
  const list = usePortalData(loadRemittances);
  const [open, setOpen] = useState<string | null>(null);
  const lines = usePortalData(() => (open ? loadRemittanceLines(open) : Promise.resolve([])), [open]);
  const [busy, setBusy] = useState(false);
  async function upload(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try { const r = await ingestRemittance(f); toast(r.needs_manual_entry ? t('remit.manual') : t('remit.uploaded'), 'success'); list.reload(); setOpen(r.remittance_id); }
    catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  async function confirm(id: string) {
    setBusy(true);
    try { const n = await rpc<number>('portal_confirm_remittance', { p_remittance_id: id }); toast(t('remit.applied', { n }), 'success'); list.reload(); lines.reload(); }
    catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  async function dismiss(id: string) {
    try { await rpc('portal_dismiss_remittance_line', { p_line_id: id }); lines.reload(); list.reload(); } catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); }
  }
  return (
    <div className="space-y-4">
      <Input label={t('remit.upload')} type="file" accept=".txt,.csv,.pdf,image/png,image/jpeg" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      <p className="text-sm text-text-secondary">{t('remit.reviewNote')}</p>
      <Card padding="md"><Panel state={list} empty={t('remit.empty')} t={t}>{(rows) => <ul className="divide-y divide-border">{rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm"><div><span className="text-text-primary" dir="ltr">{r.payment_ref ?? t('console.none')}</span><span className="text-text-secondary"> · {fmt(r.created_at, lang)} · {r.status}</span></div><Button size="sm" variant="secondary" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{t('remit.review')}</Button></li>))}</ul>}</Panel></Card>
      {open && <Card padding="md"><Panel state={lines} empty={t('remit.empty')} t={t}>{(rows) => (<div className="space-y-3">
        <ul className="divide-y divide-border">{rows.map((l) => (<li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm"><div><span className="text-text-primary" dir="ltr">{l.invoice_number}</span><span className="text-text-secondary"> · {money(l.amount_cents, lang)} · {t(`remit.match${l.match_status.charAt(0).toUpperCase()}${l.match_status.slice(1)}`)}{l.resolution !== 'pending' ? ` · ${l.resolution}` : ''}</span></div>{l.resolution === 'pending' && <Button size="sm" variant="ghost" onClick={() => dismiss(l.id)}>{t('remit.dismiss')}</Button>}</li>))}</ul>
        <Button loading={busy} disabled={!rows.some((l) => l.match_status === 'matched' && l.resolution === 'pending')} onClick={() => confirm(open)}>{t('remit.confirm')}</Button></div>)}</Panel></Card>}
    </div>
  );
}

// ------------------------------------------------------------------ settings ------------------------------------------------------------
function Settings({ t, isOwner, onSaved }: { t: TFn; isOwner: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const cur = usePortalData(loadSettings);
  const [s, setS] = useState<AccountSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) setS(cur.data); }, [cur.data]);
  const sw = (k: keyof AccountSettings, label: string, disabled = false) => (
    <label className="flex items-start gap-3 py-2 text-sm text-text-primary"><input type="checkbox" role="switch" className="mt-1" checked={s[k]} disabled={!isOwner || disabled} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /><span>{label}</span></label>);
  async function save() {
    setBusy(true);
    try { await rpc('portal_set_account_settings', { p_submission_enabled: s.submission_enabled, p_email: s.email_channel_enabled, p_assisted: s.assisted_channel_enabled, p_api: s.api_channel_enabled, p_automation: s.automation_channel_enabled, p_automation_kill: s.automation_kill, p_require_approval: true }); toast(t('settings.saved'), 'success'); cur.reload(); onSaved(); }
    catch (e) { toast(t(`errors.${errKey(e)}`, { defaultValue: t('errors.generic') }), 'error'); } finally { setBusy(false); }
  }
  if (cur.loading) return <Skeleton className="h-40 w-full" />;
  if (cur.error) return <div role="alert"><p className="text-sm">{t('page.loadFailed')}</p><Button size="sm" variant="secondary" onClick={cur.reload}>{t('page.retry')}</Button></div>;
  return (
    <Card padding="md" className="space-y-2"><h2 className="font-medium text-text-primary">{t('settings.title')}</h2><p className="text-sm text-text-secondary">{t('settings.intro')}</p>
      {!isOwner && <p className="text-sm text-text-secondary" role="note">{t('settings.ownerOnly')}</p>}
      {sw('submission_enabled', t('settings.enabled'))}{sw('email_channel_enabled', t('settings.email'))}{sw('assisted_channel_enabled', t('settings.assisted'))}{sw('api_channel_enabled', t('settings.api'))}
      {sw('automation_channel_enabled', t('settings.automation'))}{sw('automation_kill', t('settings.kill'))}{sw('require_approval', t('settings.approval'), true)}
      <p className="text-sm text-text-secondary">{t('settings.automationNote')}</p>
      <div className="rounded-control border border-border p-3 text-sm text-text-secondary" role="note"><strong className="text-text-primary">{t('consent.title')}</strong><p className="mt-1">{t('consent.body')}</p></div>
      {isOwner && <Button loading={busy} onClick={save}>{t('settings.save')}</Button>}
    </Card>
  );
}

// ------------------------------------------------------------------ page ----------------------------------------------------------------
export function PortalSubmissionsPage() {
  const { t, language } = usePortalT();
  const { user } = useAuth();
  const online = useOnline();
  const [tab, setTab] = useState<Tab>('console');
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [owner, setOwner] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [{ data: can }, { data: oid }] = await Promise.all([supabase.rpc('commercial_can_bill'), supabase.rpc('get_account_owner_id')]);
      const st = await loadSettings().catch(() => DEFAULT_SETTINGS);
      if (!live) return;
      setAllowed(can === true); setOwner(Boolean(user?.id) && oid === user?.id); setEnabled(st.submission_enabled);
    })();
    return () => { live = false; };
  }, [user?.id, tick]);

  if (allowed === null) return <div className="space-y-3 p-6" role="status" aria-busy="true"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;
  if (!allowed) return <main className="p-6"><Card padding="md" role="alert"><h1 className="text-lg font-semibold text-text-primary">{t('forbidden.title')}</h1><p className="mt-1 text-sm text-text-secondary">{t('forbidden.body')}</p></Card></main>;
  return (
    <main className="space-y-4 p-6">
      <header><h1 className="text-xl font-semibold text-text-primary">{t('page.title')}</h1><p className="text-sm text-text-secondary">{t('page.subtitle')}</p></header>
      {!online && <p role="status" className="rounded-control border border-border p-3 text-sm text-warning">{t('page.offline')}</p>}
      {enabled === false && <Card padding="md" role="status"><h2 className="font-medium text-text-primary">{t('disabled.title')}</h2><p className="text-sm text-text-secondary">{t('disabled.body')}</p></Card>}
      <div role="tablist" aria-label={t('tabs.label')} className="flex gap-1 border-b border-border">
        {TABS.map((k) => (
          <button key={k} id={`ps-tab-${k}`} role="tab" type="button" aria-selected={tab === k} aria-controls={`ps-panel-${k}`} tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)} onKeyDown={(e) => { const i = TABS.indexOf(k); const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (n) { const dir = document.documentElement.dir === 'rtl' ? -n : n; const next = TABS[(i + dir + TABS.length) % TABS.length]; setTab(next); document.getElementById(`ps-tab-${next}`)?.focus(); } }}
            className={`focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-current text-text-primary' : 'border-transparent text-text-secondary'}`}>{t(`tabs.${k}`)}</button>))}
      </div>
      <div role="tabpanel" id={`ps-panel-${tab}`} aria-labelledby={`ps-tab-${tab}`} tabIndex={0}>
        {tab === 'console' && <Console t={t} lang={language} />}
        {tab === 'profiles' && <Profiles t={t} lang={language} isOwner={owner} />}
        {tab === 'remittances' && <Remittances t={t} lang={language} />}
        {tab === 'settings' && <Settings t={t} isOwner={owner} onSaved={() => setTick((n) => n + 1)} />}
      </div>
    </main>
  );
}
