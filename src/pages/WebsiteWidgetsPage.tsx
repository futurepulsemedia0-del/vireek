import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Check, Code2, Copy, Globe, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { WidgetPreview } from '@/components/websiteWidgets/WidgetPreview';
import {
  INSTALL_TIPS,
  LIMITS,
  PLATFORM_LABELS,
  REVIEW_PLATFORMS,
  TYPE_META,
  WIDGET_TYPES,
  buildDefaults,
  buildWidgetSnippet,
  formatCount,
  formatPercent,
  friendlySaveError,
  getReadinessIssues,
  hasErrors,
  normalizeSettings,
  parseDomains,
  settingsEqual,
  summarizeStats,
  validateSettings,
  withOptions,
  type DailyStatRow,
  type ReadinessContext,
  type ReviewPlatform,
  type WidgetRow,
  type WidgetSettings,
  type WidgetType,
} from '@/lib/websiteWidgets';
import {
  fetchPreviewData,
  fetchReadinessContext,
  fetchWidgetStats,
  fetchWidgets,
  rotateWidgetKey,
  saveWidget,
  type WidgetMap,
} from '@/lib/websiteWidgetsApi';

const LABEL = 'Website Widgets';
const inputCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary disabled:opacity-60';
const labelCls = 'mb-1 block text-xs font-medium text-text-secondary';
const STATS_DAYS = 30;

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-bg-primary p-1">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}
          className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${value === o.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(1, ...points);
  const w = 120;
  const h = 28;
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, points.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Views over the last 30 days" className="text-accent">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function WebsiteWidgetsPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_edit_business_profile;

  const [active, setActive] = useState<WidgetType>('booking');
  const [rows, setRows] = useState<WidgetMap>({ booking: null, quote: null, reviews: null });
  const [drafts, setDrafts] = useState<Record<WidgetType, WidgetSettings>>(() => ({ booking: buildDefaults('booking'), quote: buildDefaults('quote'), reviews: buildDefaults('reviews') }));
  const [domainsText, setDomainsText] = useState<Record<WidgetType, string>>({ booking: '', quote: '', reviews: '' });
  const [servicesText, setServicesText] = useState('');
  const [stats, setStats] = useState<DailyStatRow[]>([]);
  const [readiness, setReadiness] = useState<ReadinessContext>({ bookingEnabled: false, bookingSlug: null, serviceCount: 0, reviewCount: 0 });
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null);
  const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [map, st, ready] = await Promise.all([
        fetchWidgets(accountOwnerId),
        fetchWidgetStats(accountOwnerId, STATS_DAYS).catch(() => [] as DailyStatRow[]),
        fetchReadinessContext(accountOwnerId).catch(() => null),
      ]);
      setRows(map);
      const nextDrafts = {} as Record<WidgetType, WidgetSettings>;
      const nextDomains = {} as Record<WidgetType, string>;
      for (const t of WIDGET_TYPES) {
        nextDrafts[t] = normalizeSettings(t, map[t]);
        nextDomains[t] = nextDrafts[t].allowed_domains.join('\n');
      }
      setDrafts(nextDrafts);
      setDomainsText(nextDomains);
      setServicesText(nextDrafts.quote.widget_type === 'quote' ? nextDrafts.quote.options.custom_services.join('\n') : '');
      setStats(st);
      if (ready) setReadiness(ready);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => { load(); }, [load]);

  const row: WidgetRow | null = rows[active];
  const parsedDomains = useMemo(() => parseDomains(domainsText[active]), [domainsText, active]);
  const effective = useMemo<WidgetSettings>(() => {
    const d = drafts[active];
    if (d.widget_type === 'quote') {
      const custom = [...new Set(servicesText.split('\n').map((x) => x.trim()).filter(Boolean))];
      return { ...d, allowed_domains: parsedDomains.domains, options: { ...d.options, custom_services: custom } };
    }
    return { ...d, allowed_domains: parsedDomains.domains } as WidgetSettings;
  }, [drafts, active, parsedDomains.domains, servicesText]);
  const saved = useMemo(() => normalizeSettings(active, row), [active, row]);
  const errors = useMemo(() => {
    const e = validateSettings(effective);
    if (parsedDomains.invalid.length) e.allowed_domains = `Not a valid domain: ${parsedDomains.invalid.slice(0, 3).join(', ')}`;
    return e;
  }, [effective, parsedDomains.invalid]);
  const dirty = row === null ? true : !settingsEqual(effective, saved);
  const showErr = (k: keyof typeof errors) => (submitted ? errors[k] : undefined);
  const issues = useMemo(() => getReadinessIssues(effective, readiness), [effective, readiness]);

  // Real data (hours, busy slots, services, ratings) for the preview; refetched when the data-shaping options change.
  const optionsKey = JSON.stringify(effective.options);
  useEffect(() => {
    if (!accountOwnerId) return;
    let cancelled = false;
    setPreviewData(null);
    fetchPreviewData(active, effective.options).then((d) => !cancelled && setPreviewData(d), () => !cancelled && setPreviewData({ unavailable: true }));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountOwnerId, active, optionsKey]);

  const patch = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) => setDrafts((d) => ({ ...d, [active]: { ...d[active], [key]: value } as WidgetSettings }));
  const patchOptions = (p: Record<string, unknown>) => setDrafts((d) => ({ ...d, [active]: withOptions(d[active], p as never) }));

  const snippet = useMemo(() => {
    if (!row) return '';
    return buildWidgetSnippet({
      type: active,
      mode: row.display_mode,
      origin: window.location.origin,
      publicKey: row.public_key,
      supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '',
      supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
    });
  }, [row, active]);

  const summary = useMemo(() => {
    const ids = row ? [row.id] : [];
    return summarizeStats(stats.filter((s) => ids.includes(s.widget_id)), STATS_DAYS);
  }, [stats, row]);

  const handleSave = async () => {
    setSubmitted(true);
    if (!accountOwnerId || hasErrors(errors)) { toast('Fix the highlighted fields first.', 'error'); return; }
    setSaving(true);
    try {
      const next = await saveWidget(accountOwnerId, effective);
      setRows((r) => ({ ...r, [active]: next }));
      setDrafts((d) => ({ ...d, [active]: normalizeSettings(active, next) }));
      setDomainsText((d) => ({ ...d, [active]: next.allowed_domains.join('\n') }));
      setSubmitted(false);
      toast(`${TYPE_META[active].label} widget saved.`, 'success');
    } catch (err) {
      toast(friendlySaveError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy failed — select the snippet and copy it manually.', 'error');
    }
  };

  const handleRotate = async () => {
    if (!window.confirm('Generate a new install key? The snippet currently on your website will stop working until you replace it.')) return;
    setRotating(true);
    try {
      const key = await rotateWidgetKey(active);
      setRows((r) => (r[active] ? { ...r, [active]: { ...r[active]!, public_key: key, last_seen_at: null, last_seen_host: null } } : r));
      toast('New key generated — update the snippet on your website.', 'success');
    } catch (err) {
      toast(friendlySaveError(err, 'Could not rotate the key.'), 'error');
    } finally {
      setRotating(false);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-secondary" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Access restricted</h3>
          <p className="mt-1.5 text-sm text-text-secondary">You need the “Edit business profile” permission to configure website widgets. Ask your account owner.</p>
        </div>
      </DashboardLayout>
    );
  }

  const isFloating = effective.display_mode === 'floating';

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Globe size={22} /> Website Widgets</h1>
        <p className="mt-1 text-sm text-text-secondary">Add booking, quote requests and your star rating to your own website with one copy-paste snippet each.</p>
      </div>

      <div role="tablist" aria-label="Widget type" className="mb-6 flex flex-wrap gap-2">
        {WIDGET_TYPES.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={active === t} onClick={() => { setActive(t); setSubmitted(false); }}
            className={`focus-ring rounded-xl border px-4 py-2 text-left text-sm transition-colors ${active === t ? 'border-accent bg-accent/10 text-text-primary' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}>
            <span className="block font-semibold">{TYPE_META[t].label}</span>
            <span className="block text-xs">{rows[t]?.enabled ? 'Live' : rows[t] ? 'Disabled' : 'Not set up'}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]" aria-busy="true" aria-label="Loading widgets">
          <div className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
          <div className="h-[560px] animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <AlertTriangle className="mx-auto mb-3 text-warning-500" size={28} />
          <h3 className="text-lg font-semibold text-text-primary">Couldn’t load your widgets</h3>
          <p className="mt-1.5 text-sm text-text-secondary">Check your connection and try again.</p>
          <button type="button" onClick={load} className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"><RefreshCw size={14} /> Retry</button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <div className="min-w-0 space-y-6">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">{TYPE_META[active].label} widget</h2>
                  <p className="mt-0.5 text-xs text-text-secondary">{TYPE_META[active].blurb}</p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" role="switch" checked={effective.enabled} onChange={(e) => patch('enabled', e.target.checked)} className="h-4 w-4 rounded border-border" />
                  Enabled
                </label>
              </div>
              {issues.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-text-primary" aria-live="polite">
                  {issues.map((i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning-500" />{i}</li>)}
                </ul>
              )}
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Appearance</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Brand color" error={showErr('brand_color')}>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Pick brand color" value={/^#[0-9a-fA-F]{6}$/.test(effective.brand_color) ? effective.brand_color : '#3448E8'} onChange={(e) => patch('brand_color', e.target.value.toUpperCase())} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-bg-primary p-1" />
                    <input value={effective.brand_color} onChange={(e) => patch('brand_color', e.target.value.trim())} maxLength={7} className={inputCls} />
                  </div>
                </Field>
                <Field label="Corner radius" error={showErr('radius')} hint="0 = square, 24 = very round.">
                  <input type="range" min={LIMITS.radiusMin} max={LIMITS.radiusMax} value={effective.radius} onChange={(e) => patch('radius', Number(e.target.value))} aria-label="Corner radius" className="w-full" />
                </Field>
                <Field label="Display">
                  <Segmented label="Display mode" value={effective.display_mode} onChange={(v) => patch('display_mode', v)}
                    options={[{ value: 'floating', label: 'Floating button' }, { value: 'inline', label: 'Inside the page' }]} />
                </Field>
                <Field label="Theme" hint="“Auto” matches your page's background.">
                  <Segmented label="Theme" value={effective.theme} onChange={(v) => patch('theme', v)} options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
                </Field>
                {isFloating && (
                  <Field label="Position">
                    <Segmented label="Position" value={effective.position} onChange={(v) => patch('position', v)} options={[{ value: 'right', label: 'Bottom right' }, { value: 'left', label: 'Bottom left' }]} />
                  </Field>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Title" error={showErr('title')}>
                  <input value={effective.title} maxLength={LIMITS.title} onChange={(e) => patch('title', e.target.value)} className={inputCls} />
                </Field>
                {active !== 'reviews' && (
                  <Field label="Subtitle" error={showErr('subtitle')}>
                    <input value={effective.subtitle} maxLength={LIMITS.subtitle} onChange={(e) => patch('subtitle', e.target.value)} className={inputCls} />
                  </Field>
                )}
                {(active === 'reviews' || isFloating) && (
                  <Field label={active === 'reviews' ? 'Link label' : 'Button label'} error={showErr('button_label')} hint={active === 'reviews' ? 'Shown next to the rating when a review link is set.' : undefined}>
                    <input value={effective.button_label} maxLength={LIMITS.button} onChange={(e) => patch('button_label', e.target.value)} className={inputCls} />
                  </Field>
                )}
                {active !== 'reviews' && (
                  <Field label="Success message" error={showErr('success_message')}>
                    <input value={effective.success_message} maxLength={LIMITS.success} onChange={(e) => patch('success_message', e.target.value)} className={inputCls} />
                  </Field>
                )}
              </div>
            </Card>

            {effective.widget_type === 'booking' && (
              <Card className="space-y-3 p-5">
                <h2 className="text-sm font-semibold text-text-primary">Booking</h2>
                <p className="text-xs text-text-secondary">Hours, buffers, lead time, deposit, intake questions and hidden services come from your Booking Settings, so the widget always matches your /book page.</p>
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={effective.options.collect_notes} onChange={(e) => patchOptions({ collect_notes: e.target.checked })} className="h-4 w-4 rounded border-border" />
                  Ask for notes
                </label>
              </Card>
            )}

            {effective.widget_type === 'quote' && (
              <Card className="space-y-4 p-5">
                <h2 className="text-sm font-semibold text-text-primary">Form</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Contact required">
                    <select value={effective.options.contact_required} onChange={(e) => patchOptions({ contact_required: e.target.value })} className={inputCls}>
                      <option value="either">Phone or email</option>
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                    </select>
                  </Field>
                  <Field label="Services list">
                    <Segmented label="Services list" value={effective.options.services_mode} onChange={(v) => patchOptions({ services_mode: v })} options={[{ value: 'business', label: 'My business services' }, { value: 'custom', label: 'Custom list' }]} />
                  </Field>
                </div>
                {effective.options.services_mode === 'custom' && (
                  <Field label="Services (one per line)" error={showErr('custom_services')}>
                    <textarea rows={4} value={servicesText} onChange={(e) => setServicesText(e.target.value)} className={inputCls} />
                  </Field>
                )}
                <div className="flex flex-wrap gap-6 text-sm text-text-primary">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={effective.options.ask_zip} onChange={(e) => patchOptions({ ask_zip: e.target.checked })} className="h-4 w-4 rounded border-border" /> Ask for ZIP code</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={effective.options.message_required} onChange={(e) => patchOptions({ message_required: e.target.checked })} className="h-4 w-4 rounded border-border" /> Require a job description</label>
                </div>
                <p className="text-xs text-text-secondary">Requests land in your Leads with the source “website_quote_widget”.</p>
              </Card>
            )}

            {effective.widget_type === 'reviews' && (
              <Card className="space-y-4 p-5">
                <h2 className="text-sm font-semibold text-text-primary">Reviews</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Layout">
                    <Segmented label="Layout" value={effective.options.layout} onChange={(v) => patchOptions({ layout: v })} options={[{ value: 'badge', label: 'Rating badge' }, { value: 'cards', label: 'Badge + review cards' }]} />
                  </Field>
                  <Field label="Show from N reviews" error={showErr('min_reviews')} hint="Hide the widget until you have at least this many.">
                    <input type="number" min={LIMITS.minReviewsMin} max={LIMITS.minReviewsMax} value={effective.options.min_reviews} onChange={(e) => patchOptions({ min_reviews: Number(e.target.value) })} className={inputCls} />
                  </Field>
                  {effective.options.layout === 'cards' && (
                    <>
                      <Field label="Cards to show" error={showErr('max_excerpts')}>
                        <input type="number" min={LIMITS.excerptsMin} max={LIMITS.excerptsMax} value={effective.options.max_excerpts} onChange={(e) => patchOptions({ max_excerpts: Number(e.target.value) })} className={inputCls} />
                      </Field>
                      <Field label="Quote reviews rated at least" error={showErr('min_rating')} hint="Only affects the cards — your average always includes every review.">
                        <input type="number" min={LIMITS.ratingMin} max={LIMITS.ratingMax} value={effective.options.min_rating} onChange={(e) => patchOptions({ min_rating: Number(e.target.value) })} className={inputCls} />
                      </Field>
                    </>
                  )}
                </div>
                <Field label="Include platforms" error={showErr('platforms')}>
                  <div className="flex flex-wrap gap-4 text-sm text-text-primary">
                    {REVIEW_PLATFORMS.map((p: ReviewPlatform) => (
                      <label key={p} className="flex items-center gap-2">
                        <input type="checkbox" checked={effective.options.platforms.includes(p)} className="h-4 w-4 rounded border-border"
                          onChange={(e) => patchOptions({ platforms: REVIEW_PLATFORMS.filter((x) => (x === p ? e.target.checked : effective.options.platforms.includes(x))) })} />
                        {PLATFORM_LABELS[p]}
                      </label>
                    ))}
                  </div>
                </Field>
                <Field label="“See all reviews” link" error={showErr('cta_url')} hint="Optional. Leave empty to use your Google review link from Reputation.">
                  <input value={effective.options.cta_url} onChange={(e) => patchOptions({ cta_url: e.target.value.trim() })} placeholder="https://g.page/r/…" className={inputCls} />
                </Field>
                <p className="text-xs text-text-secondary">Reviewer names are shortened (“Jane D.”) and long text is trimmed. Check each review platform’s terms before displaying its reviews on your site.</p>
              </Card>
            )}

            <Card className="space-y-3 p-5">
              <h2 className="text-sm font-semibold text-text-primary">Allowed websites</h2>
              <Field label="Domains (one per line)" error={showErr('allowed_domains')} hint="Leave empty to allow any site. A domain also covers its subdomains. Best-effort protection — the install key is public.">
                <textarea rows={3} value={domainsText[active]} onChange={(e) => setDomainsText((d) => ({ ...d, [active]: e.target.value }))} placeholder="yourcompany.com" className={`${inputCls} font-mono`} />
              </Field>
            </Card>

            <div className="sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/95 px-4 py-3 shadow-card backdrop-blur">
              <p className="text-xs text-text-secondary" aria-live="polite">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</p>
              <button type="button" onClick={handleSave} disabled={saving || !dirty} className="focus-ring rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
                {saving ? 'Saving…' : row === null ? 'Create widget' : 'Save changes'}
              </button>
            </div>
          </div>

          <div className="min-w-0 space-y-6 lg:sticky lg:top-4 lg:self-start">
            <Card className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-primary">Live preview</h2>
                <Segmented label="Preview theme" value={previewTheme} onChange={setPreviewTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              </div>
              <WidgetPreview settings={effective} data={previewData} theme={previewTheme} />
              <p className="text-xs text-text-secondary">Real data from your account. Nothing you do in the preview is submitted or counted.</p>
            </Card>

            <Card className="space-y-3 p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"><Code2 size={15} /> Install</h2>
              {row === null ? (
                <p className="text-sm text-text-secondary">Click “Create widget” to generate your install snippet.</p>
              ) : (
                <>
                  <p className="text-xs text-text-secondary">
                    {row.display_mode === 'inline' ? <>Put the <code className="rounded bg-bg-tertiary px-1">&lt;div&gt;</code> where the widget should appear; the script can go anywhere after it.</> : <>Paste this just before the closing <code className="rounded bg-bg-tertiary px-1">&lt;/body&gt;</code> tag on every page.</>}
                  </p>
                  <pre className="max-h-48 overflow-auto rounded-xl border border-border bg-bg-primary p-3 text-[11px] leading-relaxed text-text-primary"><code>{snippet}</code></pre>
                  {dirty && <p className="text-xs text-warning-500">Save your changes — the snippet always uses your last saved settings.</p>}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={handleCopy} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white hover:opacity-90">
                      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy snippet'}
                    </button>
                    <button type="button" onClick={handleRotate} disabled={rotating} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
                      <RefreshCw size={14} className={rotating ? 'animate-spin' : ''} /> {rotating ? 'Rotating…' : 'Rotate key'}
                    </button>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-bg-primary px-3 py-2 text-xs text-text-secondary" aria-live="polite">
                    {row.last_seen_at ? <>Installed — last seen on <span className="font-medium text-text-primary">{row.last_seen_host}</span> {timeAgo(row.last_seen_at)}.</> : 'Not detected yet — it appears here after the first page load with the snippet.'}
                  </div>
                  <details className="text-xs text-text-secondary">
                    <summary className="cursor-pointer font-medium text-text-primary">Where do I paste it?</summary>
                    <ul className="mt-2 space-y-1.5">{INSTALL_TIPS.map((t) => <li key={t.platform}><span className="font-medium text-text-primary">{t.platform}:</span> {t.steps}</li>)}</ul>
                  </details>
                </>
              )}
            </Card>

            <Card className="space-y-3 p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"><BarChart3 size={15} /> Last {STATS_DAYS} days</h2>
              {row === null ? (
                <p className="text-sm text-text-secondary">Stats appear once the widget is live.</p>
              ) : (
                <>
                  <dl className="grid grid-cols-3 gap-3 text-center">
                    <div><dt className="text-[11px] text-text-secondary">Views</dt><dd className="text-lg font-semibold text-text-primary">{formatCount(summary.views)}</dd></div>
                    <div><dt className="text-[11px] text-text-secondary">{active === 'reviews' ? 'Opened' : 'Opened'}</dt><dd className="text-lg font-semibold text-text-primary">{formatCount(summary.opens)} <span className="text-xs font-normal text-text-secondary">{formatPercent(summary.openRate)}</span></dd></div>
                    <div><dt className="text-[11px] text-text-secondary">{active === 'booking' ? 'Bookings' : active === 'quote' ? 'Requests' : 'Link clicks'}</dt><dd className="text-lg font-semibold text-text-primary">{formatCount(summary.conversions)} <span className="text-xs font-normal text-text-secondary">{formatPercent(summary.conversionRate)}</span></dd></div>
                  </dl>
                  <div className="flex justify-center"><Sparkline points={summary.series.map((p) => p.views)} /></div>
                  <p className="text-xs text-text-secondary">A view is counted once per visitor session. Bookings and requests are counted on the server, so they can’t be inflated from a page.</p>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
