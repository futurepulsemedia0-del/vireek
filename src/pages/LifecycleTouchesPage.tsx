import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarHeart, ChevronLeft, ChevronRight, Gift, Mail, MessageSquare, Ticket } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DELIVERY_LABEL,
  MONTH_NAMES,
  TEMPLATE_VARIABLES,
  TOUCH_DOT,
  TOUCH_META,
  TOUCH_TYPES,
  buildMonthGrid,
  deliveryState,
  formatOffer,
  groupByDate,
  gridRange,
  normalizeOfferCode,
  parseEquipmentTypes,
  relativeDayLabel,
  renderTemplate,
  rowKey,
  sampleVars,
  shiftMonth,
  smsSegments,
  touchTitle,
  validateSettingsDraft,
  validateTemplate,
  zonedNow,
  type CalendarRow,
  type Channel,
  type OfferType,
  type TouchSettings,
  type TouchType,
} from '@/lib/lifecycle';
import {
  ensureSetup,
  getCalendar,
  getRecentLog,
  getStats,
  listCampaigns,
  listSteps,
  redeemOffer,
  removeStep,
  saveSettings,
  saveTemplate,
  setTouchActive,
  type CampaignInfo,
  type LogEntry,
  type RedeemResult,
  type TemplateStep,
  type TouchStats,
} from '@/lib/lifecycleApi';

type Tab = 'calendar' | 'automations' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'automations', label: 'Automations' },
  { id: 'activity', label: 'Activity & offers' },
];

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary focus-visible:border-accent';

const STATE_STYLE: Record<string, string> = {
  sent: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  pending: 'bg-warning-500/10 text-warning-500',
  skipped: 'bg-bg-tertiary text-text-secondary',
  scheduled: 'bg-accent/10 text-accent',
  not_opted_in: 'bg-bg-tertiary text-text-secondary',
};

export default function LifecycleTouchesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('calendar');
  const [settings, setSettings] = useState<TouchSettings[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
  const [steps, setSteps] = useState<TemplateStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const s = await ensureSetup();
      const ids = s.map((x) => x.campaign_id).filter(Boolean) as string[];
      const [c, st] = await Promise.all([listCampaigns(ids), listSteps(ids)]);
      setSettings(s);
      setCampaigns(c);
      setSteps(st);
    } catch (e) {
      setError(true);
      toast(e instanceof Error ? e.message : 'Could not load lifecycle settings.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-2 flex items-center gap-3">
          <CalendarHeart className="h-7 w-7 text-accent" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-text-primary">Lifecycle Touches</h1>
        </div>
        <p className="mb-6 text-text-secondary">
          Birthday, home-purchase, equipment-install and first-service anniversaries — automatic, personal, and sent only to customers who opted in.
          Built on your <Link to="/dashboard/marketing" className="text-accent underline">marketing campaigns</Link>.
        </p>

        <div role="tablist" className="mb-6 flex gap-2 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <SkeletonCardList count={3} rows={3} />
        ) : error ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
            <span>Couldn&apos;t set up lifecycle touches.</span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {tab === 'calendar' && <CalendarTab settings={settings} campaigns={campaigns} onGoAutomations={() => setTab('automations')} />}
            {tab === 'automations' && (
              <div className="space-y-5">
                {TOUCH_TYPES.map((t) => {
                  const s = settings.find((x) => x.touch_type === t);
                  if (!s) return null;
                  return (
                    <TouchCard
                      key={t}
                      settings={s}
                      campaign={campaigns.find((c) => c.id === s.campaign_id)}
                      steps={steps.filter((st) => st.campaign_id === s.campaign_id)}
                      onChanged={load}
                    />
                  );
                })}
              </div>
            )}
            {tab === 'activity' && <ActivityTab />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function CalendarTab({ settings, campaigns, onGoAutomations }: { settings: TouchSettings[]; campaigns: CampaignInfo[]; onGoAutomations: () => void }) {
  const { toast } = useToast();
  const today = useMemo(() => zonedNow(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone).date, []);
  const [ym, setYm] = useState({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(today);
  const [hidden, setHidden] = useState<TouchType[]>([]);

  const grid = useMemo(() => buildMonthGrid(ym.year, ym.month), [ym]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = gridRange(grid);
    getCalendar(from, to)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && toast(e instanceof Error ? e.message : 'Could not load the calendar.', 'error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [grid, toast]);

  const visible = useMemo(() => rows.filter((r) => !hidden.includes(r.touch_type)), [rows, hidden]);
  const byDate = useMemo(() => groupByDate(visible), [visible]);
  const dayRows = byDate.get(selected) ?? [];
  const activeCount = settings.filter((s) => campaigns.find((c) => c.id === s.campaign_id)?.status === 'active').length;

  return (
    <div>
      {activeCount === 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary p-4 text-sm">
          <span className="text-text-secondary">No touch is switched on yet — the calendar shows what <em>would</em> go out.</span>
          <Button size="sm" onClick={onGoAutomations}>Set up automations</Button>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Previous month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <h2 className="min-w-[10rem] text-center text-lg font-semibold text-text-primary">{MONTH_NAMES[ym.month - 1]} {ym.year}</h2>
          <Button variant="ghost" size="sm" aria-label="Next month" onClick={() => setYm((v) => shiftMonth(v.year, v.month, 1))}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="secondary" size="sm" onClick={() => { setYm({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }); setSelected(today); }}>Today</Button>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {TOUCH_TYPES.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-1.5 text-text-secondary">
              <input type="checkbox" checked={!hidden.includes(t)} onChange={() => setHidden((h) => (h.includes(t) ? h.filter((x) => x !== t) : [...h, t]))} />
              <span className={`h-2.5 w-2.5 rounded-full ${TOUCH_DOT[t]}`} aria-hidden="true" />
              {TOUCH_META[t].label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border text-xs" role="grid" aria-label="Lifecycle calendar">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="bg-bg-tertiary py-1.5 text-center font-medium text-text-secondary">{d}</div>
            ))}
            {grid.map((c) => {
              const items = byDate.get(c.iso) ?? [];
              const types = TOUCH_TYPES.filter((t) => items.some((i) => i.touch_type === t));
              return (
                <button
                  key={c.iso}
                  role="gridcell"
                  aria-selected={selected === c.iso}
                  aria-label={`${c.iso}${items.length ? `, ${items.length} touches` : ''}`}
                  onClick={() => setSelected(c.iso)}
                  className={`min-h-[64px] bg-bg-secondary p-1.5 text-left transition-colors hover:bg-bg-tertiary ${c.inMonth ? '' : 'opacity-40'} ${selected === c.iso ? 'ring-2 ring-inset ring-accent' : ''}`}
                >
                  <span className={`text-xs ${c.iso === today ? 'rounded-full bg-accent px-1.5 py-0.5 font-semibold text-white' : 'text-text-primary'}`}>{c.day}</span>
                  {items.length > 0 && (
                    <span className="mt-1 flex flex-wrap items-center gap-0.5">
                      {types.map((t) => <span key={t} className={`h-2 w-2 rounded-full ${TOUCH_DOT[t]}`} />)}
                      <span className="ml-0.5 text-[10px] text-text-secondary">{items.length}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {loading && <Skeleton className="mt-3 h-4 w-40" />}
        </div>

        <aside className="rounded-xl border border-border bg-bg-secondary p-4" aria-live="polite">
          <h3 className="font-semibold text-text-primary">{selected}</h3>
          <p className="mb-3 text-xs text-text-secondary">{relativeDayLabel(today, selected)}</p>
          {dayRows.length === 0 ? (
            <EmptyState icon={CalendarHeart} title="Nothing scheduled" description="No lifecycle touches fall on this day." />
          ) : (
            <ul className="space-y-2">
              {dayRows.map((r) => {
                const state = deliveryState(r);
                return (
                  <li key={rowKey(r)} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Link to={`/dashboard/customers/${r.customer_id}`} className="font-medium text-text-primary hover:text-accent">{r.customer_name}</Link>
                        <p className="flex items-center gap-1.5 text-xs text-text-secondary"><span className={`h-2 w-2 rounded-full ${TOUCH_DOT[r.touch_type]}`} />{touchTitle(r)}</p>
                      </div>
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}>{DELIVERY_LABEL[state]}</span>
                    </div>
                    <p className="mt-1.5 flex items-center gap-2 text-xs text-text-secondary">
                      <Mail className={`h-3.5 w-3.5 ${r.email_consent ? 'text-accent' : 'opacity-30'}`} aria-label={r.email_consent ? 'Email allowed' : 'Email not allowed'} />
                      <MessageSquare className={`h-3.5 w-3.5 ${r.sms_consent ? 'text-accent' : 'opacity-30'}`} aria-label={r.sms_consent ? 'SMS allowed' : 'SMS not allowed'} />
                      {!r.opted_in && <span>Ask this customer to opt in on their profile to send this touch.</span>}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One automation (settings + templates)
// ---------------------------------------------------------------------------

interface Draft {
  lead_days: number; send_hour: number; min_years: number; max_years: number; equipment: string;
  offer_enabled: boolean; offer_type: OfferType; offer_value: string; offer_title: string; offer_terms: string; offer_valid_days: number;
  emailOn: boolean; emailSubject: string; emailBody: string; smsOn: boolean; smsBody: string;
}

function toDraft(s: TouchSettings, steps: TemplateStep[]): Draft {
  const email = steps.find((x) => x.channel === 'email');
  const sms = steps.find((x) => x.channel === 'sms');
  return {
    lead_days: s.lead_days, send_hour: s.send_hour, min_years: s.min_years, max_years: s.max_years, equipment: s.equipment_types.join(', '),
    offer_enabled: s.offer_enabled, offer_type: s.offer_type, offer_value: s.offer_value == null ? '' : String(s.offer_value),
    offer_title: s.offer_title ?? '', offer_terms: s.offer_terms ?? '', offer_valid_days: s.offer_valid_days,
    emailOn: Boolean(email), emailSubject: email?.subject ?? '', emailBody: email?.body ?? '', smsOn: Boolean(sms), smsBody: sms?.body ?? '',
  };
}

function TouchCard({ settings, campaign, steps, onChanged }: { settings: TouchSettings; campaign: CampaignInfo | undefined; steps: TemplateStep[]; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const meta = TOUCH_META[settings.touch_type];
  const [d, setD] = useState<Draft>(() => toDraft(settings, steps));
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [previewChannel, setPreviewChannel] = useState<Channel>('email');
  const active = campaign?.status === 'active';
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const offerValue = d.offer_value.trim() === '' ? null : Number(d.offer_value);
  const settingsErrors = validateSettingsDraft({ ...d, offer_value: offerValue, offer_title: d.offer_title });
  const emailCheck = d.emailOn ? validateTemplate('email', d.emailSubject, d.emailBody) : { errors: [], warnings: [] };
  const smsCheck = d.smsOn ? validateTemplate('sms', null, d.smsBody) : { errors: [], warnings: [] };
  const channelError = !d.emailOn && !d.smsOn ? 'Keep at least one channel.' : '';
  const hasErrors = Object.keys(settingsErrors).length > 0 || emailCheck.errors.length > 0 || smsCheck.errors.length > 0 || Boolean(channelError) || (d.offer_value.trim() !== '' && Number.isNaN(offerValue));

  const offerText = formatOffer({ offer_enabled: d.offer_enabled, offer_type: d.offer_type, offer_value: offerValue, offer_title: d.offer_title, offer_terms: null, offer_valid_days: d.offer_valid_days });
  const vars = sampleVars(settings.touch_type, 'Your Company', Boolean(offerText));
  if (offerText) vars.offer = offerText;
  const previewText = previewChannel === 'email' ? renderTemplate(d.emailBody, vars) : renderTemplate(d.smsBody, vars);
  const previewSubject = renderTemplate(d.emailSubject, vars);
  const seg = smsSegments(previewText);

  const save = async () => {
    if (hasErrors || !campaign) return;
    setSaving(true);
    try {
      await saveSettings(settings.id, {
        lead_days: d.lead_days, send_hour: d.send_hour, min_years: d.min_years, max_years: d.max_years,
        equipment_types: parseEquipmentTypes(d.equipment), offer_enabled: d.offer_enabled, offer_type: d.offer_type,
        offer_value: offerValue, offer_title: d.offer_title.trim() || null, offer_terms: d.offer_terms.trim() || null, offer_valid_days: d.offer_valid_days,
      });
      const email = steps.find((x) => x.channel === 'email');
      const sms = steps.find((x) => x.channel === 'sms');
      if (d.emailOn) await saveTemplate({ campaignId: campaign.id, existing: email, allSteps: steps, channel: 'email', subject: d.emailSubject, body: d.emailBody });
      else if (email) await removeStep(email.id);
      if (d.smsOn) await saveTemplate({ campaignId: campaign.id, existing: sms, allSteps: steps, channel: 'sms', subject: null, body: d.smsBody });
      else if (sms) await removeStep(sms.id);
      toast('Saved.', 'success');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    if (!campaign) return;
    if (!active && hasErrors) {
      setOpen(true);
      toast('Fix the highlighted problems before switching this on.', 'error');
      return;
    }
    try {
      await setTouchActive(campaign.id, !active);
      toast(active ? `${meta.label} paused.` : `${meta.label} is on — it only goes to customers who opted in.`, 'success');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change status.', 'error');
    }
  };

  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-text-primary"><span className={`h-2.5 w-2.5 rounded-full ${TOUCH_DOT[settings.touch_type]}`} aria-hidden="true" />{meta.label}</h3>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{meta.description}</p>
          <p className="mt-1 text-xs text-text-secondary">Data: {meta.dataSource}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide' : 'Edit'}</Button>
          <Button variant={active ? 'secondary' : 'primary'} size="sm" onClick={() => void toggle()} aria-pressed={active}>{active ? 'Pause' : 'Switch on'}</Button>
        </div>
      </div>
      <p className="mt-2 text-xs"><span className={`rounded-full px-2 py-0.5 font-medium ${active ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-secondary'}`}>{active ? 'Active' : 'Off'}</span></p>

      {open && (
        <div className="mt-5 space-y-6 border-t border-border pt-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Input label="Days before" type="number" min={0} max={30} value={d.lead_days} onChange={(e) => set({ lead_days: Number(e.target.value) })} error={settingsErrors.lead_days} helperText="0 = on the day" />
            <Input label="Send at (hour)" type="number" min={0} max={23} value={d.send_hour} onChange={(e) => set({ send_hour: Number(e.target.value) })} error={settingsErrors.send_hour} helperText="Business time; quiet hours still apply" />
            {meta.hasYears && <Input label="From year" type="number" min={1} value={d.min_years} onChange={(e) => set({ min_years: Number(e.target.value) })} error={settingsErrors.min_years} />}
            {meta.hasYears && <Input label="Up to year" type="number" min={1} value={d.max_years} onChange={(e) => set({ max_years: Number(e.target.value) })} error={settingsErrors.max_years} />}
          </div>
          {settings.touch_type === 'equipment_install_anniversary' && (
            <Input label="Only these equipment types" value={d.equipment} onChange={(e) => set({ equipment: e.target.value })} helperText="Comma-separated, e.g. furnace, ac. Empty = all equipment." />
          )}

          <fieldset className="rounded-lg border border-border p-4">
            <legend className="flex items-center gap-2 px-1 text-sm font-medium text-text-primary"><Gift className="h-4 w-4" aria-hidden="true" /> Offer</legend>
            <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.offer_enabled} onChange={(e) => set({ offer_enabled: e.target.checked })} /> Include a unique, expiring offer code</label>
            {d.offer_enabled && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor={`ot-${settings.id}`} className="mb-1.5 block text-sm font-medium text-text-primary">Type</label>
                  <select id={`ot-${settings.id}`} className={selectClass} value={d.offer_type} onChange={(e) => set({ offer_type: e.target.value as OfferType })}>
                    <option value="percent_off">Percent off</option><option value="amount_off">Amount off</option><option value="free_service">Free service</option><option value="custom">Custom text</option>
                  </select>
                </div>
                {(d.offer_type === 'percent_off' || d.offer_type === 'amount_off') && (
                  <Input label={d.offer_type === 'percent_off' ? 'Percent' : 'Amount ($)'} type="number" min={0} value={d.offer_value} onChange={(e) => set({ offer_value: e.target.value })} error={settingsErrors.offer_value} />
                )}
                <Input label="Applies to / title" value={d.offer_title} onChange={(e) => set({ offer_title: e.target.value })} error={settingsErrors.offer_title} helperText={'e.g. "any repair" or "Free 21-point tune-up"'} />
                <Input label="Valid for (days)" type="number" min={1} max={365} value={d.offer_valid_days} onChange={(e) => set({ offer_valid_days: Number(e.target.value) })} error={settingsErrors.offer_valid_days} />
                <div className="sm:col-span-2"><Input label="Terms (optional)" value={d.offer_terms} onChange={(e) => set({ offer_terms: e.target.value })} helperText="Shown in the email. Example: one use per household, not combinable." /></div>
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="space-y-5">
              <TemplateEditor title="Email" icon={Mail} on={d.emailOn} onToggle={(v) => set({ emailOn: v })} check={emailCheck}>
                <Input label="Subject" value={d.emailSubject} onChange={(e) => set({ emailSubject: e.target.value })} />
                <Textarea label="Message" rows={9} value={d.emailBody} onChange={(e) => set({ emailBody: e.target.value })} />
              </TemplateEditor>
              <TemplateEditor title="Text message" icon={MessageSquare} on={d.smsOn} onToggle={(v) => set({ smsOn: v })} check={smsCheck}>
                <Textarea label="Message" rows={4} value={d.smsBody} onChange={(e) => set({ smsBody: e.target.value })} helperText="“Reply STOP to opt out.” is added automatically." />
              </TemplateEditor>
              {channelError && <p role="alert" className="text-xs text-danger">{channelError}</p>}
              <p className="text-xs text-text-secondary">Placeholders: {TEMPLATE_VARIABLES.map((v) => <code key={v.key} className="mr-1.5" title={`${v.description} — e.g. ${v.example}`}>{`{{${v.key}}}`}</code>)}. Wrap offer-only text in <code>{'{{#offer}}…{{/offer}}'}</code>.</p>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-medium text-text-primary">Preview (sample customer)</h4>
                <div className="flex gap-1">
                  {(['email', 'sms'] as Channel[]).map((c) => (
                    <button key={c} onClick={() => setPreviewChannel(c)} aria-pressed={previewChannel === c} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${previewChannel === c ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}>{c === 'email' ? 'Email' : 'SMS'}</button>
                  ))}
                </div>
              </div>
              <div className="whitespace-pre-wrap rounded-lg border border-border bg-bg-primary p-4 text-sm text-text-primary">
                {previewChannel === 'email' && <p className="mb-3 border-b border-border pb-2 font-medium">{previewSubject || '(no subject)'}</p>}
                {previewText || '(empty)'}
              </div>
              {previewChannel === 'sms' && <p className="mt-1.5 text-xs text-text-secondary">≈ {seg.segments} segment{seg.segments === 1 ? '' : 's'} · {seg.length} characters ({seg.encoding === 'gsm7' ? 'standard' : 'unicode'})</p>}
            </div>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} disabled={saving || hasErrors}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function TemplateEditor({ title, icon: Icon, on, onToggle, check, children }: { title: string; icon: typeof Mail; on: boolean; onToggle: (v: boolean) => void; check: { errors: string[]; warnings: string[] }; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <label className="flex items-center gap-2 text-sm font-medium text-text-primary"><input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /><Icon className="h-4 w-4" aria-hidden="true" /> {title}</label>
      {on && (
        <>
          {children}
          {check.errors.map((m) => <p key={m} role="alert" className="text-xs text-danger">{m}</p>)}
          {check.warnings.map((m) => <p key={m} className="text-xs text-warning-500">{m}</p>)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity, stats, offer redemption
// ---------------------------------------------------------------------------

function ActivityTab() {
  const { toast } = useToast();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<TouchStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, s] = await Promise.all([getRecentLog(100), getStats(90)]);
      setLog(l);
      setStats(s);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load activity.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const redeem = async () => {
    const normalized = normalizeOfferCode(code);
    if (!normalized) { setResult(null); toast('That does not look like a valid code (LC-XXXX-XXXX).', 'error'); return; }
    setRedeeming(true);
    try {
      setResult(await redeemOffer(normalized));
      setCode('');
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not redeem.', 'error');
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        {TOUCH_TYPES.map((t) => {
          const s = stats.find((x) => x.touch_type === t);
          return (
            <div key={t} className="rounded-xl border border-border bg-bg-secondary p-4">
              <p className="text-xs text-text-secondary">{TOUCH_META[t].label} · 90 days</p>
              <p className="mt-1 text-2xl font-bold text-text-primary">{loading ? '…' : (s?.touches_sent ?? 0)}</p>
              <p className="text-xs text-text-secondary">{s?.offers_redeemed ?? 0} of {s?.offers_sent ?? 0} offers redeemed</p>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-text-primary"><Ticket className="h-4 w-4" aria-hidden="true" /> Redeem an offer code</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1"><Input label="Code from the customer" placeholder="LC-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void redeem()} /></div>
          <Button onClick={() => void redeem()} disabled={redeeming || !code.trim()}>{redeeming ? 'Checking…' : 'Redeem'}</Button>
        </div>
        {result && (
          <p role="status" className={`mt-3 text-sm ${result.ok ? 'text-success' : 'text-danger'}`}>
            {result.ok
              ? `Valid — honour “${result.offer}” for ${result.customer_name ?? 'this customer'}.${result.terms ? ` Terms: ${result.terms}` : ''}`
              : result.reason === 'expired' ? 'This code has expired.' : result.reason === 'already_redeemed' ? 'This code was already redeemed.' : 'Code not found.'}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <h3 className="mb-3 font-semibold text-text-primary">Recent activity</h3>
        {loading ? <Skeleton className="h-24 w-full" /> : log.length === 0 ? (
          <EmptyState icon={CalendarHeart} title="Nothing sent yet" description="Messages appear here once a switched-on touch reaches an opted-in customer." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-text-secondary"><tr><th className="py-2 pr-3">Customer</th><th className="pr-3">Touch</th><th className="pr-3">Channel</th><th className="pr-3">Status</th><th className="pr-3">Offer</th><th>Date</th></tr></thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-2 pr-3 text-text-primary">{l.customers?.name ?? '—'}</td>
                    <td className="pr-3">{TOUCH_META[l.touch_type].label}{l.years_count ? ` · ${l.years_count} yr` : ''}</td>
                    <td className="pr-3">{l.channel === 'email' ? 'Email' : 'SMS'}</td>
                    <td className="pr-3" title={l.error ?? l.skip_reason ?? undefined}>{l.status}{l.skip_reason ? ` (${l.skip_reason.replace(/_/g, ' ')})` : ''}</td>
                    <td className="pr-3">{l.offer_code ? `${l.offer_code}${l.redeemed_at ? ' ✓' : ''}` : '—'}</td>
                    <td className="text-text-secondary">{l.occurrence_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
