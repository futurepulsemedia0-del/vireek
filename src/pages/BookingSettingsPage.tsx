import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, ExternalLink, ListChecks, Lock, Palette, TriangleAlert as AlertTriangle, Wallet } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { BookingLinkCard } from '@/components/settings/BookingLinkCard';
import { IntakeQuestionsEditor } from '@/components/booking/IntakeQuestionsEditor';
import {
  BOOKING_LIMITS,
  DAY_LABELS,
  DAY_ORDER,
  brandingStyle,
  formatCents,
  generateSlots,
  validateSettings,
  type BookingSettings,
  type BusyInterval,
} from '@/lib/bookingPolicy';
import {
  loadBookingSettings,
  loadUpcomingBusy,
  saveBookingSettings,
  type LoadedBookingSettings,
} from '@/lib/bookingSettings';

const PAGE = 'Booking Settings';

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <p className="text-xs text-text-secondary">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

const numValue = (n: number) => (Number.isNaN(n) ? '' : String(n));
const parseNum = (v: string) => (v.trim() === '' ? NaN : Number(v));

function NoAccess() {
  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Booking settings are restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

export function BookingSettingsPage() {
  const auth = useAuth();
  const { permissions, profileLoading } = auth;
  const { toast } = useToast();
  const navigate = useNavigate();
  // Account owner's id: team members must read/write the OWNER's row. The cast
  // keeps this working whether or not AuthContext exposes accountOwnerId.
  const ownerId =
    (auth as unknown as { accountOwnerId?: string }).accountOwnerId ?? auth.teamMember?.account_owner_id ?? auth.user?.id ?? null;

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loaded, setLoaded] = useState<LoadedBookingSettings | null>(null);
  const [saved, setSaved] = useState<BookingSettings | null>(null);
  const [draft, setDraft] = useState<BookingSettings | null>(null);
  const [depositText, setDepositText] = useState('');
  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [slugTaken, setSlugTaken] = useState(false);

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const result = await loadBookingSettings(ownerId);
      setLoaded(result);
      setSaved(result.settings);
      setDraft(result.settings);
      setDepositText(result.settings.depositCents > 0 ? (result.settings.depositCents / 100).toFixed(2) : '');
      setStatus('ready');
      loadUpcomingBusy(ownerId, result.settings.windowDays).then(setBusy).catch(() => setBusy([]));
    } catch {
      setStatus('error');
    }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)), [draft, saved]);
  const errors = useMemo(() => (draft ? validateSettings(draft) : {}), [draft]);
  const shown = showErrors ? errors : {};

  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const preview = useMemo(() => {
    if (!draft || !loaded || Object.keys(validateSettings(draft)).some((k) => ['duration', 'leadTime', 'window', 'bufferBefore', 'bufferAfter', 'hours'].includes(k))) return [];
    return generateSlots(
      {
        hours: draft.useBusinessHours ? loaded.businessHours : draft.hours,
        holidays: loaded.holidays,
        durationMinutes: draft.durationMinutes,
        leadTimeHours: draft.leadTimeHours,
        windowDays: draft.windowDays,
        bufferBefore: draft.bufferBefore,
        bufferAfter: draft.bufferAfter,
      },
      busy,
      new Date(),
      6,
    );
  }, [draft, loaded, busy]);

  if (profileLoading) {
    return <DashboardLayout activeLabel={PAGE}><SkeletonCardList count={3} rows={3} /></DashboardLayout>;
  }
  if (!permissions.can_edit_business_profile) return <NoAccess />;

  const set = (patch: Partial<BookingSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setBranding = (patch: Partial<BookingSettings['branding']>) => setDraft((d) => (d ? { ...d, branding: { ...d.branding, ...patch } } : d));

  const handleSave = async () => {
    if (!draft || !loaded || !ownerId) return;
    setShowErrors(true);
    if (Object.keys(errors).length > 0) { toast('Fix the highlighted fields to save.', 'error'); return; }
    setSaving(true);
    const result = await saveBookingSettings(ownerId, draft, loaded.services, loaded.hasProfile);
    setSaving(false);
    if (!result.ok) {
      if (result.reason === 'slug_taken') { setSlugTaken(true); toast('That booking link is already taken.', 'error'); }
      else toast('Could not save booking settings. Please try again.', 'error');
      return;
    }
    const next = { ...draft, hiddenServices: draft.hiddenServices.filter((h) => loaded.services.includes(h)) };
    setSaved(next);
    setDraft(next);
    setLoaded({ ...loaded, hasProfile: true });
    setShowErrors(false);
    toast('Booking settings saved.', 'success');
  };

  const handleDiscard = () => {
    if (!saved) return;
    setDraft(saved);
    setDepositText(saved.depositCents > 0 ? (saved.depositCents / 100).toFixed(2) : '');
    setShowErrors(false);
    setSlugTaken(false);
  };

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><CalendarClock size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Booking Settings</h1>
            <p className="text-sm text-text-secondary">Control what customers see and can book on your public booking page.</p>
          </div>
        </div>
        {draft?.slug && saved?.enabled && (
          <a href={`/book/${draft.slug}`} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
            <ExternalLink size={14} /> View live page
          </a>
        )}
      </div>

      {status === 'loading' && <SkeletonCardList count={4} rows={3} />}

      {status === 'error' && (
        <EmptyState icon={AlertTriangle} title="Couldn't load booking settings" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      )}

      {status === 'ready' && draft && loaded && (
        <div className="space-y-5 pb-28">
          <div>
            <BookingLinkCard slug={draft.slug} enabled={draft.enabled} onSlugChange={(slug) => { setSlugTaken(false); set({ slug }); }} onEnabledChange={(enabled) => set({ enabled })} />
            {(shown.slug || slugTaken) && <p role="alert" className="mt-2 text-xs text-danger">{slugTaken ? 'That booking link is already taken — try another.' : shown.slug}</p>}
          </div>

          <Section icon={<ListChecks size={18} />} title="Services shown" description="Choose which of your services customers can pick when they book.">
            {loaded.services.length === 0 ? (
              <EmptyState icon={ListChecks} title="No services listed yet" description="Add the services you offer in your business profile, then choose which ones appear here."
                action={{ label: 'Open business profile', onClick: () => navigate('/dashboard/business-profile') }} />
            ) : (
              <>
                <ul className="divide-y divide-border rounded-xl border border-border bg-bg-primary">
                  {loaded.services.map((service) => {
                    const visible = !draft.hiddenServices.includes(service);
                    return (
                      <li key={service} className="flex items-center justify-between gap-4 px-4 py-3">
                        <span className="text-sm text-text-primary">{service}</span>
                        <Switch checked={visible} label={`Show ${service} on the booking page`}
                          onChange={(v) => set({ hiddenServices: v ? draft.hiddenServices.filter((h) => h !== service) : [...draft.hiddenServices, service] })} />
                      </li>
                    );
                  })}
                </ul>
                {loaded.services.every((s) => draft.hiddenServices.includes(s)) && (
                  <p className="mt-2 text-xs text-text-secondary">All services are hidden — customers will book without choosing a service.</p>
                )}
              </>
            )}
          </Section>

          <Section icon={<CalendarClock size={18} />} title="Availability" description="When customers can book, how far ahead, and how much breathing room you need between jobs.">
            <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-primary px-4 py-3">
              <div>
                <p className="text-sm font-medium text-text-primary">Use my business hours</p>
                <p className="text-xs text-text-secondary">Turn off to offer different hours for online booking only.</p>
              </div>
              <Switch checked={draft.useBusinessHours} label="Use business hours for online booking" onChange={(v) => set({ useBusinessHours: v })} />
            </div>

            <ul className="mb-1 space-y-2">
              {DAY_ORDER.map((day) => {
                const custom = !draft.useBusinessHours;
                const h = draft.hours[day];
                const err = shown[`hours.${day}`];
                return (
                  <li key={day}>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex w-32 items-center gap-2 text-sm text-text-primary">
                        <input type="checkbox" disabled={!custom} checked={Boolean(h)} className="h-4 w-4 accent-[rgb(var(--accent-primary))]"
                          onChange={(e) => {
                            const hours = { ...draft.hours };
                            if (e.target.checked) hours[day] = { open: '09:00', close: '17:00' }; else delete hours[day];
                            set({ hours });
                          }} />
                        {DAY_LABELS[day]}
                      </label>
                      {h ? (
                        <div className="flex items-center gap-2">
                          <input type="time" aria-label={`${DAY_LABELS[day]} opens`} disabled={!custom} value={h.open} onChange={(e) => set({ hours: { ...draft.hours, [day]: { ...h, open: e.target.value } } })} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60" />
                          <span className="text-xs text-text-secondary">to</span>
                          <input type="time" aria-label={`${DAY_LABELS[day]} closes`} disabled={!custom} value={h.close} onChange={(e) => set({ hours: { ...draft.hours, [day]: { ...h, close: e.target.value } } })} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60" />
                        </div>
                      ) : (
                        <span className="text-xs text-text-secondary">Closed</span>
                      )}
                    </div>
                    {err && <p role="alert" className="ml-0 mt-1 text-xs text-danger sm:ml-32">{err}</p>}
                  </li>
                );
              })}
            </ul>
            {shown.hours && <p role="alert" className="mt-1 text-xs text-danger">{shown.hours}</p>}
            {draft.useBusinessHours && Object.keys(draft.hours).length === 0 && (
              <p className="mt-2 text-xs text-text-secondary">Your business hours aren't set, so no times can be offered. Add them in your business profile or switch to custom hours.</p>
            )}

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Input label="Appointment length (minutes)" type="number" inputMode="numeric" min={BOOKING_LIMITS.durationMin} max={BOOKING_LIMITS.durationMax} value={numValue(draft.durationMinutes)} error={shown.duration} onChange={(e) => set({ durationMinutes: parseNum(e.target.value) })} />
              <Input label="Minimum notice (hours)" type="number" inputMode="numeric" min={0} max={BOOKING_LIMITS.leadTimeMaxHours} value={numValue(draft.leadTimeHours)} error={shown.leadTime} helperText="How soon before a time customers can still book it." onChange={(e) => set({ leadTimeHours: parseNum(e.target.value) })} />
              <Input label="Booking window (days ahead)" type="number" inputMode="numeric" min={BOOKING_LIMITS.windowMinDays} max={BOOKING_LIMITS.windowMaxDays} value={numValue(draft.windowDays)} error={shown.window} onChange={(e) => set({ windowDays: parseNum(e.target.value) })} />
              <Input label="Buffer before (minutes)" type="number" inputMode="numeric" min={0} max={BOOKING_LIMITS.bufferMax} value={numValue(draft.bufferBefore)} error={shown.bufferBefore} helperText="Travel or prep time before each booking." onChange={(e) => set({ bufferBefore: parseNum(e.target.value) })} />
              <Input label="Buffer after (minutes)" type="number" inputMode="numeric" min={0} max={BOOKING_LIMITS.bufferMax} value={numValue(draft.bufferAfter)} error={shown.bufferAfter} helperText="Cleanup or paperwork time after each booking." onChange={(e) => set({ bufferAfter: parseNum(e.target.value) })} />
            </div>

            <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4">
              <p className="text-xs font-medium text-text-secondary">Next open times with these settings</p>
              {preview.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {preview.map((d) => (
                    <span key={d.toISOString()} className="rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                      {d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-text-secondary">Nothing would be bookable yet — check your hours, notice and window.</p>
              )}
              <p className="mt-2 text-[11px] text-text-secondary/70">Based on your real scheduled jobs.</p>
            </div>
          </Section>

          <Section icon={<Wallet size={18} />} title="Deposit" description="Ask for a deposit to reduce no-shows. Leave empty for no deposit.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Deposit amount (USD)" type="number" inputMode="decimal" min={0} step="0.01" placeholder="0.00" value={depositText} error={shown.deposit}
                onChange={(e) => {
                  setDepositText(e.target.value);
                  set({ depositCents: e.target.value.trim() === '' ? 0 : Math.round(Number(e.target.value) * 100) });
                }} />
              <div className="sm:col-span-2">
                <Textarea label="Deposit & cancellation policy" rows={2} maxLength={BOOKING_LIMITS.policyMax + 50} value={draft.depositPolicy} error={shown.depositPolicy}
                  placeholder="e.g. Fully refundable up to 24 hours before your appointment." onChange={(e) => set({ depositPolicy: e.target.value })} />
              </div>
            </div>
            <p className="mt-3 text-xs text-text-secondary">
              {draft.depositCents > 0 ? `Customers see a ${formatCents(draft.depositCents)} deposit notice and each booked job records it as due. ` : ''}
              Payment is requested by your team — online card collection isn't part of this page.
            </p>
          </Section>

          <Section icon={<ListChecks size={18} />} title="Intake questions" description="Questions customers answer while booking. Answers are saved to the job and lead notes.">
            <IntakeQuestionsEditor questions={draft.intake} errors={shown} onChange={(intake) => set({ intake })} />
            {shown.intake && <p role="alert" className="mt-2 text-xs text-danger">{shown.intake}</p>}
          </Section>

          <Section icon={<Palette size={18} />} title="Branding" description="Make the booking page feel like your business.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="brand-color" className="mb-1.5 block text-sm font-medium text-text-primary">Accent colour</label>
                <div className="flex items-center gap-2">
                  <input id="brand-color-picker" type="color" aria-label="Pick accent colour" value={draft.branding.accent_color ?? '#203ad8'} onChange={(e) => setBranding({ accent_color: e.target.value })} className="h-12 w-14 shrink-0 cursor-pointer rounded-xl border border-border bg-bg-primary p-1" />
                  <Input id="brand-color" value={draft.branding.accent_color ?? ''} placeholder="Default Vireek blue" error={shown.accent} onChange={(e) => setBranding({ accent_color: e.target.value.trim() === '' ? null : e.target.value.trim().toLowerCase() })} />
                </div>
              </div>
              <Input label="Logo image link" type="url" placeholder="https://…/logo.png" value={draft.branding.logo_url ?? ''} error={shown.logo} helperText="Square image works best. Must be https." onChange={(e) => setBranding({ logo_url: e.target.value.trim() === '' ? null : e.target.value })} />
              <div className="sm:col-span-2">
                <Input label="Page headline" placeholder="Book an appointment" maxLength={BOOKING_LIMITS.headlineMax + 20} value={draft.branding.headline} error={shown.headline} onChange={(e) => setBranding({ headline: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Textarea label="Welcome message" rows={2} value={draft.branding.intro} error={shown.intro} placeholder="Shown above the service picker." onChange={(e) => setBranding({ intro: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Textarea label="Confirmation message" rows={2} value={draft.branding.confirmation_message} error={shown.confirmation} placeholder="Shown after a customer books — e.g. what to expect next." onChange={(e) => setBranding({ confirmation_message: e.target.value })} />
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-border bg-bg-primary p-4" style={brandingStyle(draft.branding)}>
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-text-secondary">Preview</p>
              <div className="flex items-center gap-3">
                {draft.branding.logo_url && !shown.logo ? (
                  <img src={draft.branding.logo_url} alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><CalendarClock size={20} /></span>
                )}
                <div>
                  <p className="text-base font-semibold text-text-primary">{draft.branding.headline || 'Book an appointment'}</p>
                  <p className="text-xs text-text-secondary">with your business</p>
                </div>
              </div>
              {draft.branding.intro && <p className="mt-3 text-sm text-text-secondary">{draft.branding.intro}</p>}
              <Button className="mt-4 w-full" size="sm" type="button" tabIndex={-1}>Confirm booking</Button>
            </div>
          </Section>
        </div>
      )}

      {status === 'ready' && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-secondary/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">You have unsaved changes</p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>Discard</Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
