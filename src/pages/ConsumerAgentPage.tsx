import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Copy, Lock, OctagonAlert, ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useConsumerAgentT } from '@/i18n/consumerAgentNamespace';
import {
  DECLINE_REASONS, SECTION_KEYS, decideRequest, hasFlags, loadActivity, loadPreview, loadPriceItems, loadRequests, loadSettings,
  parseServiceList, publicUrls, saveSettings, setKillSwitch, setPricePublished, statusKey,
  type Activity, type AgentRequest, type ConsumerAgentSettings, type DeclineReason, type PriceItem, type Preview, type SectionKey,
} from '@/lib/consumerAgent';

const PAGE = 'AI Agent Requests';
const publishField = (k: SectionKey) => `publish_${k}` as const;

export function ConsumerAgentPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const { t, language } = useConsumerAgentT();
  const ownerId = isOwner ? (profile?.id ?? null) : (teamMember?.account_owner_id ?? null);
  const canManage = isOwner || permissions.can_manage_team || teamMember?.role === 'admin';

  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<ConsumerAgentSettings | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [prices, setPrices] = useState<PriceItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState<DeclineReason>('unavailable');
  const [draft, setDraft] = useState({ phone: '', email: '', website: '', policies: '', autoServices: '' });

  const when = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }), [language]);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setState('loading');
    try {
      const [s, pv, rq, ac, pr] = await Promise.all([loadSettings(), loadPreview(), loadRequests(), loadActivity(), loadPriceItems(ownerId)]);
      setSettings(s); setPreview(pv); setRequests(rq); setActivity(ac); setPrices(pr);
      setDraft({ phone: s.public_phone ?? '', email: s.public_email ?? '', website: s.public_website ?? '', policies: s.policies_text ?? '', autoServices: s.auto_accept_services.join(', ') });
      setState('ready');
    } catch {
      setState('error');
    }
  }, [ownerId]);

  useEffect(() => { if (canManage && ownerId) void load(); }, [canManage, ownerId, load]);

  const refreshPreview = useCallback(async () => {
    try { setPreview(await loadPreview()); } catch { /* keep the previous preview */ }
  }, []);

  async function save(patch: Parameters<typeof saveSettings>[0], key: string) {
    setBusy(key);
    const res = await saveSettings(patch);
    setBusy(null);
    if (!res.ok) {
      toast(res.reason === 'not_ready' ? t('rules.notReady') : res.reason === 'forbidden' ? t('rules.forbidden') : t('rules.saveFailed'), 'error');
      return false;
    }
    setSettings(res.settings);
    await refreshPreview();
    return true;
  }

  async function kill(on: boolean) {
    setBusy('kill');
    const res = await setKillSwitch(on);
    setBusy(null);
    setConfirmKill(false);
    if (!res.ok) { toast(t('rules.saveFailed'), 'error'); return; }
    setSettings(res.settings);
    await refreshPreview();
    try { setRequests(await loadRequests()); } catch { /* ignore */ }
  }

  async function decide(r: AgentRequest, action: 'accept' | 'decline') {
    setBusy(r.id);
    const res = await decideRequest(r.id, action, action === 'decline' ? declineReason : undefined);
    setBusy(null);
    if (res.ok) {
      toast(action === 'accept' ? t('queue.accepted') : t('queue.declined'), 'success');
      setDeclining(null);
    } else {
      const known = ['not_open', 'slot_taken', 'too_soon', 'intake_required', 'booking_not_available'];
      toast(known.includes(res.code) ? t(`queue.errors.${res.code}`) : t('queue.actionFailed'), 'error');
    }
    try { const [rq, ac] = await Promise.all([loadRequests(), loadActivity()]); setRequests(rq); setActivity(ac); } catch { /* keep */ }
  }

  async function togglePrice(item: PriceItem, next: boolean) {
    setBusy(item.id);
    const ok = await setPricePublished(item.id, next);
    setBusy(null);
    if (!ok) { toast(t('rules.saveFailed'), 'error'); return; }
    setPrices((p) => p.map((x) => (x.id === item.id ? { ...x, agent_published: next } : x)));
    await refreshPreview();
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast(t('preview.copy'), 'success'); } catch { toast(t('rules.saveFailed'), 'error'); }
  }

  if (profileLoading) return <DashboardLayout activeLabel={PAGE}><SkeletonCardList count={3} rows={3} /></DashboardLayout>;
  if (!canManage) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <EmptyState icon={Lock} title={t('noAccess.title')} description={t('noAccess.description')} variant="no-permission" />
      </DashboardLayout>
    );
  }

  const sk = settings ? statusKey(settings, preview) : 'off';
  const urls = preview?.profile && typeof preview.profile.slug === 'string' ? publicUrls(preview.profile.slug) : null;
  const toneClass = sk === 'live' ? 'text-success-500' : sk === 'off' ? 'text-text-secondary' : 'text-danger';
  const open = requests.filter((r) => r.status === 'pending' || r.status === 'held');
  const closed = requests.filter((r) => r.status !== 'pending' && r.status !== 'held');

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Bot size={24} aria-hidden="true" /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">{t('title')}</h1>
          <p className="text-sm text-text-secondary">{t('subtitle')}</p>
        </div>
      </div>

      {state === 'loading' && <SkeletonCardList count={4} rows={3} />}
      {state === 'error' && (
        <EmptyState icon={AlertTriangle} title={t('loadFailed.title')} description={t('loadFailed.description')} variant="load-failed" onRetry={() => void load()} />
      )}

      {state === 'ready' && settings && (
        <div className="space-y-6">
          <Card interactive={false} className="!p-5" aria-labelledby="ca-status">
            <h2 id="ca-status" className="sr-only">{t('title')}</h2>
            <p role="status" className={`flex items-center gap-2 text-sm font-semibold ${toneClass}`}>
              {sk === 'live' ? <ShieldCheck size={18} aria-hidden="true" /> : <OctagonAlert size={18} aria-hidden="true" />}
              {t(`status.${sk}`)}
            </p>
            {preview && preview.blockers.length > 0 && (
              <ul className="mt-2 list-disc ps-5 text-sm text-text-secondary">
                {preview.blockers.map((b) => <li key={b}>{t(`blockers.${b}`)}</li>)}
              </ul>
            )}
            <div className="mt-4 space-y-4">
              <Switch checked={settings.enabled} label={t('enable.label')} hint={t('enable.hint')} loading={busy === 'enabled'}
                disabled={settings.kill_switch} disabledReason={t('blockers.kill_switch_on')}
                onChange={(v) => void save({ enabled: v }, 'enabled')} />
              <div className="border-t border-border pt-4">
                <p className="text-sm font-medium text-text-primary">{t('kill.label')}</p>
                <p className="mt-0.5 text-xs text-text-secondary">{t('kill.hint')}</p>
                {!settings.kill_switch && !confirmKill && (
                  <Button className="mt-3" variant="danger" size="sm" onClick={() => setConfirmKill(true)}>{t('kill.on')}</Button>
                )}
                {!settings.kill_switch && confirmKill && (
                  <div role="alertdialog" aria-label={t('kill.confirm')} className="mt-3 rounded-xl border border-danger/40 p-3">
                    <p className="text-sm text-text-primary">{t('kill.confirm')}</p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="danger" size="sm" loading={busy === 'kill'} onClick={() => void kill(true)}>{t('kill.confirmYes')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmKill(false)}>{t('kill.confirmNo')}</Button>
                    </div>
                  </div>
                )}
                {settings.kill_switch && (
                  <Button className="mt-3" variant="secondary" size="sm" loading={busy === 'kill'} onClick={() => void kill(false)}>{t('kill.off')}</Button>
                )}
              </div>
            </div>
          </Card>

          {activity && (
            <section aria-labelledby="ca-activity">
              <h2 id="ca-activity" className="mb-2 text-base font-semibold text-text-primary">{t('activity.title')}</h2>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([['calls', activity.calls_7d], ['requests', activity.requests_7d], ['accepted', activity.accepted_7d], ['denied', activity.denied_7d],
                  ['flagged', activity.flagged_7d], ['open', activity.open_now], ['overdue', activity.overdue_now]] as const).map(([k, v]) => (
                  <Card key={k} interactive={false} className="!p-4">
                    <dt className="text-xs text-text-secondary">{t(`activity.${k}`)}</dt>
                    <dd className="mt-1 text-2xl font-bold text-text-primary">{new Intl.NumberFormat(language).format(v)}</dd>
                  </Card>
                ))}
              </dl>
            </section>
          )}

          <section aria-labelledby="ca-queue">
            <h2 id="ca-queue" className="mb-2 text-base font-semibold text-text-primary">{t('queue.title')}</h2>
            {requests.length === 0 && <EmptyState icon={Bot} title={t('queue.empty.title')} description={t('queue.empty.description')} />}
            <ul className="space-y-3">
              {[...open, ...closed].map((r) => (
                <li key={r.id}>
                  <Card interactive={false} className="!p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">
                          {r.service_type} · {when.format(new Date(r.requested_start))}
                        </p>
                        <p className="text-xs text-text-secondary">
                          {t('queue.from', { agent: r.agent_label ?? t('queue.unnamed') })} · {r.principal_kind === 'registered' ? t('queue.verified') : t('queue.unverified')} · {t('queue.tag')}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${r.sla_state === 'overdue' ? 'bg-danger/10 text-danger' : r.sla_state === 'due_soon' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                        {r.sla_state === 'closed' ? t(`queue.closed.${r.status as 'accepted' | 'declined' | 'expired'}`) : t(`queue.sla.${r.sla_state}`)}
                      </span>
                    </div>
                    <dl className="mt-3 grid gap-1 text-sm text-text-primary sm:grid-cols-2">
                      <div><dt className="sr-only">{r.contact_name}</dt><dd>{r.contact_name}</dd></div>
                      <div><dd dir="ltr" className="text-start">{r.contact_phone ?? r.contact_email}</dd></div>
                      <div><dd>{[r.address_line, r.postal_code].filter(Boolean).join(', ')}</dd></div>
                      <div><dd className="text-xs text-text-secondary">{r.area_verified ? t('queue.areaOk') : t('queue.areaUnknown')}</dd></div>
                    </dl>
                    {r.description_untrusted && (
                      <div className="mt-3 rounded-xl bg-bg-tertiary p-3">
                        <p className="text-xs text-text-secondary">{t('queue.untrustedNote')}</p>
                        {/* Rendered as plain text by React (escaped). Never as HTML. */}
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary">{r.description_untrusted}</p>
                      </div>
                    )}
                    {hasFlags(r) && <p role="note" className="mt-2 flex items-center gap-1.5 text-xs font-medium text-danger"><AlertTriangle size={14} aria-hidden="true" />{t('queue.flagged')}</p>}
                    {(r.status === 'pending' || r.status === 'held') && (
                      <>
                        <p className="mt-2 text-xs text-text-secondary">
                          {r.status === 'held' && r.hold_expires_at ? `${t('queue.heldUntil', { time: when.format(new Date(r.hold_expires_at)) })} · ` : ''}
                          {t('queue.respondBy', { time: when.format(new Date(r.sla_due_at)) })}
                        </p>
                        {r.accept_error && <p role="alert" className="mt-2 text-xs text-danger">{t(`queue.errors.${['slot_taken', 'too_soon', 'intake_required', 'booking_not_available'].includes(r.accept_error) ? r.accept_error : 'not_open'}`)}</p>}
                        <div className="mt-3 flex flex-wrap items-end gap-2">
                          <Button size="sm" loading={busy === r.id} onClick={() => void decide(r, 'accept')}>{t('queue.accept')}</Button>
                          {declining === r.id ? (
                            <>
                              <label className="text-xs text-text-secondary">
                                <span className="block">{t('queue.declineReasonLabel')}</span>
                                <select className="focus-ring mt-1 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" value={declineReason}
                                  onChange={(e) => setDeclineReason(e.target.value as DeclineReason)}>
                                  {DECLINE_REASONS.map((d) => <option key={d} value={d}>{t(`queue.declineReasons.${d}`)}</option>)}
                                </select>
                              </label>
                              <Button variant="danger" size="sm" loading={busy === r.id} onClick={() => void decide(r, 'decline')}>{t('queue.decline')}</Button>
                            </>
                          ) : (
                            <Button variant="secondary" size="sm" onClick={() => setDeclining(r.id)}>{t('queue.decline')}</Button>
                          )}
                        </div>
                      </>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          </section>

          <Card interactive={false} className="!p-5" aria-labelledby="ca-publish">
            <h2 id="ca-publish" className="text-base font-semibold text-text-primary">{t('publish.title')}</h2>
            <p className="mt-1 text-xs text-text-secondary">{t('publish.hint')}</p>
            <div className="mt-4 space-y-4">
              {SECTION_KEYS.map((k) => (
                <Switch key={k} checked={settings[publishField(k)]} label={t(`publish.${k}`)} loading={busy === k}
                  onChange={(v) => void save({ [publishField(k)]: v }, k)} />
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Input label={t('contact.phone')} dir="ltr" inputMode="tel" maxLength={25} value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              <Input label={t('contact.email')} dir="ltr" type="email" maxLength={254} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              <Input label={t('contact.website')} dir="ltr" type="url" maxLength={200} value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} />
              <Input label={t('contact.policies')} helperText={t('contact.policiesHint')} maxLength={600} value={draft.policies} onChange={(e) => setDraft({ ...draft, policies: e.target.value })} />
            </div>
            <Button className="mt-4" size="sm" loading={busy === 'contact'} onClick={async () => {
              const ok = await save({ public_phone: draft.phone || null, public_email: draft.email || null, public_website: draft.website || null, policies_text: draft.policies || null }, 'contact');
              if (ok) toast(t('rules.saved'), 'success');
            }}>{t('rules.save')}</Button>
          </Card>

          <Card interactive={false} className="!p-5" aria-labelledby="ca-prices">
            <h2 id="ca-prices" className="text-base font-semibold text-text-primary">{t('prices.title')}</h2>
            <p className="mt-1 text-xs text-text-secondary">{t('prices.hint')}</p>
            {prices.length === 0 ? <p className="mt-3 text-sm text-text-secondary">{t('prices.empty')}</p> : (
              <div className="mt-4 space-y-3">
                {prices.map((p) => <Switch key={p.id} checked={p.agent_published} label={t('prices.toggle', { name: p.service_name })} loading={busy === p.id} onChange={(v) => void togglePrice(p, v)} />)}
              </div>
            )}
          </Card>

          <Card interactive={false} className="!p-5" aria-labelledby="ca-rules">
            <h2 id="ca-rules" className="text-base font-semibold text-text-primary">{t('rules.title')}</h2>
            <fieldset className="mt-3">
              <legend className="text-sm font-medium text-text-primary">{t('rules.mode')}</legend>
              {(['pending', 'hold'] as const).map((m) => (
                <label key={m} className="mt-2 flex items-center gap-2 text-sm text-text-primary">
                  <input type="radio" name="ca-mode" className="focus-ring" checked={settings.request_mode === m} onChange={() => void save({ request_mode: m }, 'mode')} />
                  {m === 'pending' ? t('rules.modePending') : t('rules.modeHold')}
                </label>
              ))}
            </fieldset>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Input label={t('rules.holdMinutes')} type="number" min={5} max={240} defaultValue={settings.hold_minutes} onBlur={(e) => { const n = Number(e.target.value); if (n !== settings.hold_minutes && n >= 5 && n <= 240) void save({ hold_minutes: n }, 'hold'); }} />
              <Input label={t('rules.dailyCap')} type="number" min={1} max={200} defaultValue={settings.daily_request_cap} onBlur={(e) => { const n = Number(e.target.value); if (n !== settings.daily_request_cap && n >= 1 && n <= 200) void save({ daily_request_cap: n }, 'cap'); }} />
              <Input label={t('rules.sla')} type="number" min={15} max={1440} defaultValue={settings.sla_minutes} onBlur={(e) => { const n = Number(e.target.value); if (n !== settings.sla_minutes && n >= 15 && n <= 1440) void save({ sla_minutes: n }, 'sla'); }} />
            </div>
            <div className="mt-5 border-t border-border pt-4">
              <Switch checked={settings.auto_accept_enabled} label={t('rules.autoAccept')} hint={t('rules.autoAcceptHint')} loading={busy === 'auto'} onChange={(v) => void save({ auto_accept_enabled: v }, 'auto')} />
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Input label={t('rules.autoServices')} value={draft.autoServices} onChange={(e) => setDraft({ ...draft, autoServices: e.target.value })}
                  onBlur={() => void save({ auto_accept_services: parseServiceList(draft.autoServices) }, 'autoServices')} />
                <Input label={t('rules.autoLead')} type="number" min={1} max={336} defaultValue={settings.auto_accept_min_lead_hours}
                  onBlur={(e) => { const n = Number(e.target.value); if (n !== settings.auto_accept_min_lead_hours && n >= 1 && n <= 336) void save({ auto_accept_min_lead_hours: n }, 'lead'); }} />
              </div>
            </div>
          </Card>

          <Card interactive={false} className="!p-5" aria-labelledby="ca-preview">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="ca-preview" className="text-base font-semibold text-text-primary">{t('preview.title')}</h2>
              <Button variant="ghost" size="xs" onClick={() => void refreshPreview()}>{t('preview.refresh')}</Button>
            </div>
            <p className="mt-1 text-xs text-text-secondary">{t('preview.hint')}</p>
            <pre dir="ltr" tabIndex={0} aria-label={t('preview.title')} className="focus-ring mt-3 max-h-80 overflow-auto rounded-xl bg-bg-tertiary p-3 text-start text-xs text-text-primary">
              {JSON.stringify(preview?.profile ?? null, null, 2)}
            </pre>
            {preview && <p className="mt-2 text-xs text-text-secondary">{t('preview.never', { items: preview.never_exposed.join(', ') })}</p>}
            {urls && (
              <div className="mt-4">
                <p className="text-sm font-medium text-text-primary">{t('preview.links')}</p>
                <ul className="mt-2 space-y-2">
                  {Object.entries(urls).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-2">
                      <code dir="ltr" className="min-w-0 flex-1 truncate text-start text-xs text-text-secondary">{v}</code>
                      <Button variant="ghost" size="xs" iconOnly aria-label={`${t('preview.copy')} ${k}`} onClick={() => void copy(v)}><Copy size={14} aria-hidden="true" /></Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <section aria-labelledby="ca-honesty" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h2 id="ca-honesty" className="text-base font-semibold text-text-primary">{t('honesty.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('honesty.body')}</p>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
