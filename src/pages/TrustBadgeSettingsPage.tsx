import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BadgeCheck, Check, CheckCircle2, Clock, Copy, Loader as Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  BADGE_BOX, BADGE_LOCALES, BADGE_MIN_SAMPLE, BADGE_PALETTES, BADGE_SIZES, BADGE_THEMES, BADGE_VARIANTS,
  buildReactSnippet, buildScriptSnippet, buildView, hostAllowed, normalizeDomain, parseRel, pickStat,
  type BadgeLocale, type BadgePalette, type BadgeSize, type BadgeTheme, type BadgeVariant,
} from '@/lib/trustBadge/core';
import {
  addBadgeDomain, fetchLoaderSri, friendlyBadgeError, getBadgeState, removeBadgeDomain, saveBadgeSettings, verifyBadgeDomain,
  type BadgeState,
} from '@/lib/trustBadge/api';

const LABEL = 'Trust Badge';
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const VARIANT_LABEL: Record<BadgeVariant, string> = { tiny: 'Tiny badge', stat: 'Live stat badge', card: '“Call or book now” card' };
const LOCALE_LABEL: Record<BadgeLocale, string> = { en: 'English', es: 'Español', fa: 'فارسی', ar: 'العربية', fr: 'Français', de: 'Deutsch', hi: 'हिन्दी', ja: '日本語', zh: '中文' };
const PLATFORMS = [
  { id: 'html', label: 'Any website' }, { id: 'wordpress', label: 'WordPress' }, { id: 'wix', label: 'Wix' },
  { id: 'squarespace', label: 'Squarespace' }, { id: 'webflow', label: 'Webflow' }, { id: 'react', label: 'React' },
] as const;
type PlatformId = (typeof PLATFORMS)[number]['id'];
const STEPS: Record<Exclude<PlatformId, 'react'>, string[]> = {
  html: ['Paste the snippet where the badge should appear (footer or contact section works well).', 'Publish. The badge loads on its own and reserves its space, so the page does not jump.'],
  wordpress: ['Appearance → Editor (or a page builder), add a “Custom HTML” block where you want the badge.', 'Paste the snippet and save. On classic themes use a Custom HTML widget in Appearance → Widgets.', 'Security plugins that block external scripts need cdn-free allow-listing of this site’s address.'],
  wix: ['In the Wix editor choose Add Elements → Embed Code → Embed HTML.', 'Pick “Code”, paste the snippet, and place the box where the badge should be. Size the box to at least the preview size.', 'Publish. Wix only runs embeds on your connected domain, not the preview URL.'],
  squarespace: ['Edit the page, add a “Code” block (Business plan or higher) where the badge should go.', 'Paste the snippet, untick “Display Source”, and save.', 'Use Settings → Advanced → Code Injection → Footer to show it on every page.'],
  webflow: ['Add an “Embed” element from the Add panel where the badge should appear.', 'Paste the snippet and click Save & Close, then publish the site.', 'The badge only appears on the published, verified domain — not in the Designer.'],
};

const FIELD = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';
const BOX = 'rounded-xl border border-border p-4';

function CopyBtn({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  return (
    <Button size="sm" variant="secondary" aria-label={`Copy ${label}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1800); } catch { toast('Couldn’t copy — select the text and copy it manually.', 'error'); }
    }}>{done ? <Check size={14} /> : <Copy size={14} />}<span className="ml-1.5">{done ? 'Copied' : 'Copy'}</span></Button>
  );
}

function Check2({ checked, onChange, title, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium text-text-primary">{title}</span>{hint && <span className="block text-xs text-text-secondary">{hint}</span>}</span>
    </label>
  );
}

/** Faithful preview: same view JSON the public endpoint sends, same size table as the loader. */
function Preview({ state, variant, theme, size, palette, locale, dark }: { state: BadgeState; variant: BadgeVariant; theme: BadgeTheme; size: BadgeSize; palette: BadgePalette; locale: BadgeLocale; dark: boolean }) {
  const s = state.settings;
  const stat = s.approve_answer_stats ? pickStat({ metric: s.stat_metric, ...state.liveStats }, new Date()) : null;
  const view = buildView({
    state: 'ok', variant, theme, palette, locale, stat, verifyHref: '#', rel: parseRel(s.link_rel),
    card: { phone: s.card_phone, bookingUrl: s.card_booking_enabled && state.bookingSlug ? '#' : null },
    poweredByHref: s.show_powered_by || !state.whiteLabel ? '#' : null,
  });
  const [w, h] = BADGE_BOX[variant][BADGE_SIZES.indexOf(size)];
  const useDark = theme === 'dark' || (theme === 'auto' && dark);
  const [bg, fg, bd, ac] = useDark ? view.p.d : view.p.l;
  return (
    <div style={{ width: w, height: h, maxWidth: '100%' }} role="img" aria-label={view.a}>
      <div dir={view.d} lang={view.l} style={{ display: 'flex', flexDirection: variant === 'card' ? 'column' : 'row', alignItems: variant === 'card' ? 'stretch' : 'center', gap: 8, height: '100%', padding: '0 10px', background: bg, color: fg, border: `1px solid ${bd}`, borderRadius: 8, font: '600 13px system-ui,sans-serif', overflow: 'hidden', boxSizing: 'border-box' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{view.x}</span>
          {view.y && <span style={{ fontWeight: 400, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{view.y}</span>}
        </span>
        {view.c && <span style={{ display: 'flex', gap: 8 }}>{view.c.map((c) => <span key={c.x} style={{ padding: '6px 12px', borderRadius: 6, background: ac, color: bg }}>{c.x}</span>)}</span>}
        {view.w && <span style={{ font: '400 10px system-ui', textDecoration: 'underline' }}>{view.w.x}</span>}
      </div>
    </div>
  );
}

export function TrustBadgeSettingsPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = isOwner || permissions.can_edit_business_profile;

  const [state, setState] = useState<BadgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [phone, setPhone] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [variant, setVariant] = useState<BadgeVariant>('tiny');
  const [theme, setTheme] = useState<BadgeTheme>('auto');
  const [size, setSize] = useState<BadgeSize>('md');
  const [palette, setPalette] = useState<BadgePalette>('blue');
  const [lang, setLang] = useState<BadgeLocale>('en');
  const [platform, setPlatform] = useState<PlatformId>('html');
  const [sri, setSri] = useState<string | null>(null);
  const [previewDark, setPreviewDark] = useState(false);

  const apply = useCallback((s: BadgeState) => { setState(s); setName(s.settings.display_name); setSlug(s.settings.public_slug); setPhone(s.settings.card_phone ?? ''); }, []);
  const load = useCallback(async () => {
    try { apply(await getBadgeState()); setError(null); } catch (e) { setError(friendlyBadgeError(e)); }
  }, [apply]);
  useEffect(() => { if (canManage) void load(); }, [canManage, load]);
  useEffect(() => { void fetchLoaderSri().then(setSri); }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(friendlyBadgeError(e), 'error'); } finally { setBusy(null); }
  };
  const save = (patch: Parameters<typeof saveBadgeSettings>[0], key = 'save') => run(key, async () => { apply(await saveBadgeSettings(patch)); toast('Saved', 'success'); });

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://vireek.com';
  const snippetOpts = { origin, slug: state?.settings.public_slug ?? '', variant, theme, size, palette, lang, sri } as const;
  const snippet = useMemo(() => (platform === 'react' ? buildReactSnippet(snippetOpts) : buildScriptSnippet(snippetOpts)), [platform, snippetOpts.slug, variant, theme, size, palette, lang, sri, origin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canManage) {
    return (
      <DashboardLayout activeLabel={LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <h3 className="text-lg font-semibold text-text-primary">Access restricted</h3>
          <p className="mt-1.5 text-sm text-text-secondary">You need the “Edit business profile” permission to manage the trust badge. Ask your account owner.</p>
        </div>
      </DashboardLayout>
    );
  }
  if (error) return <DashboardLayout activeLabel={LABEL}><div role="alert" className={BOX}>{error} <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></div></DashboardLayout>;
  if (!state) return <DashboardLayout activeLabel={LABEL}><p role="status" className="text-sm text-text-secondary">Loading…</p></DashboardLayout>;

  const s = state.settings;
  const verifiedHosts = [...state.domains.filter((d) => d.status === 'verified').map((d) => d.domain), ...state.inheritedDomains];
  const live = !!s.last_seen_at && Date.now() - Date.parse(s.last_seen_at) < LIVE_WINDOW_MS && !!s.last_seen_host && hostAllowed(s.last_seen_host, verifiedHosts);
  const unhealthy = state.profileStatus !== 'active' || state.subscriptionStatus === 'suspended';
  const publicUrl = `${origin}/verify/${s.public_slug}`;

  return (
    <DashboardLayout activeLabel={LABEL}>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><BadgeCheck size={24} aria-hidden="true" /> Trust badge</h1>
        <p className="mt-1 text-sm text-text-secondary">Show visitors that real calls are answered by Vireek — backed by a public verification page that only confirms what you approve.</p>
      </div>

      {unhealthy && <p role="alert" className={`${BOX} mb-4 flex gap-2 text-sm`}><AlertTriangle size={18} className="shrink-0 text-warning-500" aria-hidden="true" />Your account is not active, so the badge is hidden on your website until billing is resolved.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">1 · Domains</h2>
          <p className="text-sm text-text-secondary">The badge only appears on websites you prove you own. Add a domain, then add the DNS TXT record below.</p>
          {state.inheritedDomains.length > 0 && <p className="text-xs text-text-secondary">Already verified elsewhere in Vireek (usable automatically): {state.inheritedDomains.join(', ')}</p>}
          <ul className="space-y-3">
            {state.domains.map((d) => (
              <li key={d.id} className={BOX}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{d.domain}</span>
                  <span className={`flex items-center gap-1 text-xs ${d.status === 'verified' ? 'text-success' : 'text-text-secondary'}`}>
                    {d.status === 'verified' ? <CheckCircle2 size={14} /> : <Clock size={14} />}{d.status === 'verified' ? 'Verified' : d.status === 'failed' ? 'Not verified' : 'Waiting for DNS'}
                  </span>
                </div>
                {d.status !== 'verified' && (
                  <div className="mt-2 space-y-2 text-xs text-text-secondary">
                    <p>Add a TXT record — Name: <code>_vireek-badge</code> · Value: <code className="break-all">vireek-verify={d.verification_token}</code></p>
                    {d.last_error && <p role="status">{d.last_error}</p>}
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  {d.status !== 'verified' && <Button size="sm" variant="secondary" disabled={busy === `v${d.id}`} onClick={() => void run(`v${d.id}`, async () => { const r = await verifyBadgeDomain(d.id); toast(r.status === 'verified' ? 'Domain verified' : r.error ?? 'Not verified yet', r.status === 'verified' ? 'success' : 'error'); await load(); })}>{busy === `v${d.id}` ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}<span className="ml-1.5">Check now</span></Button>}
                  <Button size="sm" variant="ghost" aria-label={`Remove ${d.domain}`} onClick={() => void run(`r${d.id}`, async () => { await removeBadgeDomain(d.id); await load(); })}><Trash2 size={14} /></Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input className={FIELD} aria-label="Website domain" placeholder="example.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
            <Button disabled={!normalizeDomain(newDomain) || busy === 'add'} onClick={() => void run('add', async () => { await addBadgeDomain(newDomain); setNewDomain(''); await load(); })}>Add</Button>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">2 · What you approve to show publicly</h2>
          <Check2 checked={s.approve_answer_stats} onChange={(v) => void save({ approve_answer_stats: v })} title="Call statistics (last 30 days)" hint={`Shown only with at least ${BADGE_MIN_SAMPLE} recent calls and fresh data; otherwise the badge shows neutral text.`} />
          <Check2 checked={s.approve_active_since} onChange={(v) => void save({ approve_active_since: v })} title="“Using Vireek since” (month and year)" />
          <Check2 checked={s.approve_plan_category} onChange={(v) => void save({ approve_plan_category: v })} title="Plan category (Standard or Business — never prices)" />
          <label className="block text-sm"><span className="font-medium">Statistic shown on the live badge</span>
            <select className={`${FIELD} mt-1`} value={s.stat_metric} onChange={(e) => void save({ stat_metric: e.target.value as BadgeState['settings']['stat_metric'] })}>
              <option value="calls">Calls answered (last 30 days)</option>
              <option value="answer_time">Average answer time — only appears once answer times are measured</option>
            </select>
          </label>
          <label className="block text-sm"><span className="font-medium">Business name on the verification page</span>
            <div className="mt-1 flex gap-2"><input className={FIELD} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /><Button variant="secondary" disabled={name === s.display_name} onClick={() => void save({ display_name: name })}>Save</Button></div>
          </label>
          <label className="block text-sm"><span className="font-medium">Verification address</span>
            <div className="mt-1 flex gap-2"><input className={FIELD} disabled={!!s.first_enabled_at} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} /><Button variant="secondary" disabled={!!s.first_enabled_at || slug === s.public_slug} onClick={() => void save({ public_slug: slug })}>Save</Button></div>
            <span className="mt-1 block break-all text-xs text-text-secondary">{publicUrl}{s.first_enabled_at ? ' (locked after first use)' : ''}</span>
          </label>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">3 · Look &amp; links</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label>Variant<select className={`${FIELD} mt-1`} value={variant} onChange={(e) => setVariant(e.target.value as BadgeVariant)}>{BADGE_VARIANTS.map((v) => <option key={v} value={v}>{VARIANT_LABEL[v]}</option>)}</select></label>
            <label>Theme<select className={`${FIELD} mt-1`} value={theme} onChange={(e) => setTheme(e.target.value as BadgeTheme)}>{BADGE_THEMES.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label>Size<select className={`${FIELD} mt-1`} value={size} onChange={(e) => setSize(e.target.value as BadgeSize)}>{BADGE_SIZES.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label>Colors<select className={`${FIELD} mt-1`} value={palette} onChange={(e) => setPalette(e.target.value as BadgePalette)}>{BADGE_PALETTES.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label className="col-span-2">Language (right-to-left is automatic)<select className={`${FIELD} mt-1`} value={lang} onChange={(e) => setLang(e.target.value as BadgeLocale)}>{BADGE_LOCALES.map((v) => <option key={v} value={v}>{LOCALE_LABEL[v]}</option>)}</select></label>
          </div>
          {variant === 'card' && (
            <div className="space-y-3 text-sm">
              <label className="block">Phone shown on the card (international format)
                <div className="mt-1 flex gap-2"><input className={FIELD} placeholder="+15125550123" value={phone} onChange={(e) => setPhone(e.target.value)} /><Button variant="secondary" onClick={() => void save({ card_phone: phone.trim() || null })}>Save</Button></div>
              </label>
              <Check2 checked={s.card_booking_enabled} disabled={!state.bookingSlug} onChange={(v) => void save({ card_booking_enabled: v })} title="Show “Book online”" hint={state.bookingSlug ? undefined : 'Turn on online booking first.'} />
            </div>
          )}
          <fieldset className="space-y-2 text-sm"><legend className="font-medium">“Powered by Vireek” link</legend>
            <Check2 checked={s.show_powered_by || !state.whiteLabel} disabled={!state.whiteLabel} onChange={(v) => void save({ show_powered_by: v })} title="Show a small “Powered by Vireek” link" hint={state.whiteLabel ? 'Optional on your plan. It is never required for the badge to be verified.' : 'Removing it is a Business-plan white-label option.'} />
            <p className="text-xs text-text-secondary">{state.partnerApproved ? 'The link carries your partner referral code, so signups from it are credited to you.' : 'Want credit for signups from this link? Join the partner program at /affiliate.'}</p>
          </fieldset>
          <fieldset className="space-y-1 text-sm"><legend className="font-medium">Link attributes (SEO)</legend>
            <p className="text-xs text-text-secondary">“noopener” is always set. Pick any extra values for the links inside the badge.</p>
            {(['nofollow', 'sponsored', 'ugc'] as const).map((t) => <Check2 key={t} checked={s.link_rel.includes(t)} onChange={(v) => void save({ link_rel: v ? [...s.link_rel, t] : s.link_rel.filter((x) => x !== t) })} title={t} />)}
          </fieldset>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">4 · Preview &amp; install</h2>
          <div className="rounded-xl border border-border bg-bg-secondary/40 p-4">
            <Preview state={state} variant={variant} theme={theme} size={size} palette={palette} locale={lang} dark={previewDark} />
            {theme === 'auto' && <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={previewDark} onChange={(e) => setPreviewDark(e.target.checked)} /> Preview as a visitor using dark mode</label>}
            <p className="mt-2 text-xs text-text-secondary">{variant === 'stat' && !(s.approve_answer_stats && pickStat({ metric: s.stat_metric, ...state.liveStats }, new Date())) ? 'Not enough recent data (or not approved) — the live badge shows neutral text until it is.' : 'Preview uses your real data.'}</p>
          </div>
          <div role="tablist" aria-label="Platform" className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => <button key={p.id} role="tab" aria-selected={platform === p.id} onClick={() => setPlatform(p.id)} className={`focus-ring rounded-full border px-3 py-1 text-xs ${platform === p.id ? 'border-text-primary font-semibold' : 'border-border text-text-secondary'}`}>{p.label}</button>)}
          </div>
          <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-bg-secondary p-3 text-xs"><code>{snippet}</code></pre>
          <div className="flex items-center gap-2"><CopyBtn value={snippet} label="install code" />{!sri && <span className="text-xs text-text-secondary">Integrity hash unavailable; snippet works without it.</span>}</div>
          {platform !== 'react' ? <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">{STEPS[platform].map((t) => <li key={t}>{t}</li>)}</ol>
            : <p className="text-sm text-text-secondary">Render <code>{'<VireekBadge />'}</code> where the badge should appear. Server-rendered frameworks: it mounts on the client only.</p>}
          <p className="text-xs text-text-secondary">Strict Content-Security-Policy on your site? Allow <code>{origin}</code> in script-src and connect-src. Need to wait for cookie consent? Add <code>data-consent="wait"</code> and call <code>window.dispatchEvent(new Event('vireek-badge-consent'))</code> after consent.</p>
        </Card>
      </div>

      <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="text-sm">
          <h2 className="font-semibold">Install check</h2>
          {live ? <p className="mt-1 flex items-center gap-1.5 text-success"><CheckCircle2 size={16} /> Live on {s.last_seen_host} — last seen {new Date(s.last_seen_at as string).toLocaleString()}</p>
            : <p className="mt-1 text-text-secondary">Not detected in the last 24 hours. Load a page that has the badge (from a verified domain, with Do Not Track off), then check again.{s.last_seen_host ? ` Last seen on ${s.last_seen_host}.` : ''}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => void load()}><RefreshCw size={14} /><span className="ml-1.5">Check again</span></Button>
          <Button disabled={busy === 'enable' || (!s.enabled && verifiedHosts.length === 0)} onClick={() => void save({ enabled: !s.enabled }, 'enable')}>{s.enabled ? 'Disable badge' : 'Enable badge'}</Button>
        </div>
      </Card>
      {!s.enabled && <p className="mt-2 text-xs text-text-secondary">The badge stays hidden on every website until you enable it{verifiedHosts.length === 0 ? ' (verify a domain first)' : ''}.</p>}
    </DashboardLayout>
  );
}
