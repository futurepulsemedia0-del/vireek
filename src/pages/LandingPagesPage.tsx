import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  LayoutTemplate,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  LandingApiError,
  addLandingDomain,
  createLandingPage,
  deleteLandingPage,
  fetchDailySeries,
  fetchLandingAnalytics,
  fetchUtmBreakdown,
  listLandingDomains,
  listLandingPages,
  removeLandingDomain,
  saveLandingPage,
  setLandingDomainPage,
  setLandingPageStatus,
  verifyLandingDomain,
} from '@/lib/landingPages';
import type { DailyPoint, PageStats, UtmRow } from '@/lib/landingPages';
import {
  DRAFT_LIMITS,
  buildTrackedLink,
  conversionRate,
  draftFromPage,
  emptyDraft,
  formatRate,
  getPageUrl,
  parseAppHosts,
  slugify,
  txtRecordName,
  txtRecordValue,
  validateCustomDomain,
  validateDraft,
} from '@/lib/landingPageUtils';
import type {
  CtaMode,
  DraftErrors,
  LandingDomain,
  LandingPage,
  LandingPageDraft,
  LandingStatus,
} from '@/lib/landingPageUtils';

type Tab = 'pages' | 'domains' | 'analytics';
type ToastFn = ReturnType<typeof useToast>['toast'];

const APP_HOSTS = parseAppHosts(import.meta.env.VITE_APP_HOSTS);
const CNAME_TARGET = import.meta.env.VITE_LANDING_CNAME_TARGET ?? 'cname.vercel-dns.com';
const A_RECORD = '76.76.21.21';

const selectCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary';

const DOMAIN_ERROR_COPY: Record<string, string> = {
  txt_not_found: "We couldn't find the TXT record yet. DNS changes can take up to a few hours.",
  dns_lookup_failed: 'DNS lookup failed. Please try again in a moment.',
  domain_in_use: 'This domain is already verified on another account.',
  vercel_attach_failed: 'Verified, but connecting the domain to hosting failed. Click Verify to retry.',
  update_failed: 'Could not save the verification result. Please retry.',
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// ------------------------------------------------------------------
// Small presentational pieces
// ------------------------------------------------------------------

function StatusBadge({ status }: { status: LandingStatus | LandingDomain['status'] }) {
  const styles: Record<string, string> = {
    published: 'bg-success/10 text-success',
    verified: 'bg-success/10 text-success',
    draft: 'bg-bg-tertiary text-text-secondary',
    pending: 'bg-warning-500/10 text-warning-500',
    archived: 'bg-warning-500/10 text-warning-500',
    failed: 'bg-danger/10 text-danger',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${styles[status] ?? styles.draft}`}
    >
      {status}
    </span>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg-tertiary px-3 py-2.5">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-text-primary">{value}</dd>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-5">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="mt-3 h-4 w-2/3" />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((j) => (
              <Skeleton key={j} className="h-14" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-14 text-center">
      <AlertCircle className="text-danger" size={28} aria-hidden="true" />
      <h3 className="mt-3 text-base font-semibold text-text-primary">Something went wrong</h3>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">{message}</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------
// Page card
// ------------------------------------------------------------------

function PageCard({
  page,
  url,
  stats,
  busy,
  onEdit,
  onToggle,
  onDelete,
  onCopy,
}: {
  page: LandingPage;
  url: string;
  stats?: PageStats;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const conversions = stats ? stats.leads + stats.bookings : 0;
  const rate = stats ? conversionRate(conversions, stats.visitors) : 0;
  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-text-primary">{page.title}</h3>
            <StatusBadge status={page.status} />
          </div>
          <p className="mt-1 truncate text-sm text-text-secondary">{url}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil size={14} aria-hidden="true" /> Edit
          </Button>
          <Button variant="secondary" size="sm" onClick={onToggle} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {page.status === 'published' ? 'Unpublish' : 'Publish'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCopy} aria-label={`Copy link for ${page.title}`}>
            <Copy size={14} aria-hidden="true" />
          </Button>
          {page.status === 'published' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
              aria-label={`Open ${page.title}`}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} aria-label={`Delete ${page.title}`}>
            <Trash2 size={14} className="text-danger" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {stats && (
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Visitors (30d)" value={stats.visitors.toLocaleString()} />
          <StatTile label="Leads" value={stats.leads.toLocaleString()} />
          <StatTile label="Bookings" value={stats.bookings.toLocaleString()} />
          <StatTile label="Conversion" value={formatRate(rate)} />
        </dl>
      )}
    </li>
  );
}

// ------------------------------------------------------------------
// Editor
// ------------------------------------------------------------------

function PageEditor({
  initial,
  ownerId,
  onSaved,
  onCancel,
  toast,
}: {
  initial: LandingPage | null;
  ownerId: string;
  onSaved: (page: LandingPage) => void;
  onCancel: () => void;
  toast: ToastFn;
}) {
  const [draft, setDraft] = useState<LandingPageDraft>(() => (initial ? draftFromPage(initial) : emptyDraft()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const [saving, setSaving] = useState<'draft' | 'publish' | null>(null);

  const patch = (p: Partial<LandingPageDraft>) => setDraft((d) => ({ ...d, ...p }));

  const submit = async (publish: boolean) => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(publish ? 'publish' : 'draft');
    try {
      const saved = initial
        ? await saveLandingPage(ownerId, initial.id, draft, publish ? 'published' : undefined)
        : await createLandingPage(ownerId, draft, publish ? 'published' : 'draft');
      toast(publish ? 'Landing page published.' : 'Landing page saved.', 'success');
      onSaved(saved);
    } catch (e) {
      if (e instanceof LandingApiError && e.code === 'slug_taken') {
        setErrors({ slug: 'That URL is already taken — try another.' });
      } else {
        toast(errorMessage(e, 'Could not save the page.'), 'error');
      }
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text-primary">{initial ? 'Edit landing page' : 'New landing page'}</h2>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Close editor">
          <X size={16} aria-hidden="true" />
        </Button>
      </div>

      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="Internal name"
            required
            value={draft.title}
            maxLength={DRAFT_LIMITS.title}
            error={errors.title}
            onChange={(e) => patch({ title: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
          />
          <Input
            label="URL"
            required
            value={draft.slug}
            maxLength={60}
            error={errors.slug}
            helperText={`/lp/${draft.slug || 'your-page'}`}
            onChange={(e) => {
              setSlugTouched(true);
              patch({ slug: slugify(e.target.value) });
            }}
          />
        </div>

        <Input
          label="Headline"
          required
          value={draft.headline}
          maxLength={DRAFT_LIMITS.headline}
          error={errors.headline}
          onChange={(e) => patch({ headline: e.target.value })}
        />
        <Input
          label="Subheadline"
          value={draft.subheadline}
          maxLength={DRAFT_LIMITS.subheadline}
          error={errors.subheadline}
          onChange={(e) => patch({ subheadline: e.target.value })}
        />
        <Textarea
          label="Body"
          rows={5}
          value={draft.body}
          maxLength={DRAFT_LIMITS.body}
          error={errors.body}
          helperText="Plain text. Line breaks are kept."
          onChange={(e) => patch({ body: e.target.value })}
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">Highlights (up to {DRAFT_LIMITS.maxSections})</legend>
          <div className="space-y-3">
            {draft.sections.map((s, i) => (
              <div key={i} className="grid gap-3 rounded-xl bg-bg-tertiary p-3 sm:grid-cols-[1fr_2fr_auto]">
                <Input
                  aria-label={`Highlight ${i + 1} title`}
                  placeholder="Title"
                  value={s.title}
                  maxLength={DRAFT_LIMITS.sectionTitle}
                  onChange={(e) =>
                    patch({ sections: draft.sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })
                  }
                />
                <Input
                  aria-label={`Highlight ${i + 1} text`}
                  placeholder="Short description"
                  value={s.body}
                  maxLength={DRAFT_LIMITS.sectionBody}
                  onChange={(e) =>
                    patch({ sections: draft.sections.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove highlight ${i + 1}`}
                  onClick={() => patch({ sections: draft.sections.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={14} className="text-danger" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
          {errors.sections && (
            <p className="mt-1.5 text-xs text-danger" role="alert">
              {errors.sections}
            </p>
          )}
          {draft.sections.length < DRAFT_LIMITS.maxSections && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => patch({ sections: [...draft.sections, { title: '', body: '' }] })}
            >
              <Plus size={14} aria-hidden="true" /> Add highlight
            </Button>
          )}
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-3">
          <Input
            label="Button text"
            required
            value={draft.cta_label}
            maxLength={DRAFT_LIMITS.ctaLabel}
            error={errors.cta_label}
            onChange={(e) => patch({ cta_label: e.target.value })}
          />
          <div>
            <label htmlFor="lp-cta-mode" className="mb-1.5 block text-sm font-medium text-text-primary">
              Conversion type
            </label>
            <select
              id="lp-cta-mode"
              className={selectCls}
              value={draft.cta_mode}
              onChange={(e) => patch({ cta_mode: e.target.value as CtaMode })}
            >
              <option value="lead_form">Contact form</option>
              <option value="booking">Online booking</option>
              <option value="both">Form + booking</option>
            </select>
            {draft.cta_mode !== 'lead_form' && (
              <p className="mt-1.5 text-xs text-text-secondary">
                Needs Online Booking enabled; otherwise visitors see the contact form.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="lp-accent" className="mb-1.5 block text-sm font-medium text-text-primary">
              Accent color
            </label>
            <div className="flex items-center gap-2">
              <input
                id="lp-accent"
                type="color"
                className="focus-ring h-12 w-14 cursor-pointer rounded-xl border border-border bg-bg-primary p-1"
                value={/^#[0-9a-fA-F]{6}$/.test(draft.accent_color) ? draft.accent_color : '#2563eb'}
                onChange={(e) => patch({ accent_color: e.target.value })}
              />
              <Input
                aria-label="Accent color hex"
                value={draft.accent_color}
                maxLength={7}
                error={errors.accent_color}
                onChange={(e) => patch({ accent_color: e.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="SEO title"
            value={draft.seo_title}
            maxLength={DRAFT_LIMITS.seoTitle}
            error={errors.seo_title}
            helperText={`${draft.seo_title.length}/${DRAFT_LIMITS.seoTitle}`}
            onChange={(e) => patch({ seo_title: e.target.value })}
          />
          <Input
            label="SEO description"
            value={draft.seo_description}
            maxLength={DRAFT_LIMITS.seoDescription}
            error={errors.seo_description}
            helperText={`${draft.seo_description.length}/${DRAFT_LIMITS.seoDescription}`}
            onChange={(e) => patch({ seo_description: e.target.value })}
          />
        </div>
      </div>

      <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={saving !== null}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => submit(false)} disabled={saving !== null}>
          {saving === 'draft' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {initial ? 'Save changes' : 'Save draft'}
        </Button>
        {(!initial || initial.status !== 'published') && (
          <Button onClick={() => submit(true)} disabled={saving !== null}>
            {saving === 'publish' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Save &amp; publish
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Domains
// ------------------------------------------------------------------

function RecordRow({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-16 shrink-0 text-xs font-medium text-text-secondary">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary">
        {value}
      </code>
      <Button variant="ghost" size="sm" onClick={() => onCopy(value)} aria-label={`Copy ${label}`}>
        <Copy size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}

function DomainsPanel({
  ownerId,
  pages,
  domains,
  onDomainsChange,
  toast,
}: {
  ownerId: string;
  pages: LandingPage[];
  domains: LandingDomain[];
  onDomainsChange: (next: LandingDomain[]) => void;
  toast: ToastFn;
}) {
  const [input, setInput] = useState('');
  const [pageId, setPageId] = useState('');
  const [inputError, setInputError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<LandingDomain | null>(null);

  const copy = async (value: string) => {
    toast((await copyToClipboard(value)) ? 'Copied.' : 'Could not copy — select and copy manually.', 'info');
  };

  const handleAdd = async () => {
    const check = validateCustomDomain(input, APP_HOSTS);
    if (!check.ok) {
      setInputError(
        check.reason === 'reserved'
          ? 'That domain cannot be used.'
          : 'Enter a valid domain, like book.yourbusiness.com.',
      );
      return;
    }
    setInputError(undefined);
    setAdding(true);
    try {
      const created = await addLandingDomain(ownerId, check.domain, pageId || null);
      onDomainsChange([created, ...domains]);
      setInput('');
      toast('Domain added. Now add the DNS records below.', 'success');
    } catch (e) {
      if (e instanceof LandingApiError && e.code === 'domain_exists') setInputError('You already added this domain.');
      else toast(errorMessage(e, 'Could not add the domain.'), 'error');
    } finally {
      setAdding(false);
    }
  };

  const replace = (next: LandingDomain) => onDomainsChange(domains.map((d) => (d.id === next.id ? next : d)));

  const handleVerify = async (d: LandingDomain) => {
    setBusyId(d.id);
    try {
      const result = await verifyLandingDomain(d.id);
      const fresh = await listLandingDomains(ownerId);
      onDomainsChange(fresh);
      if (result.status === 'verified') {
        toast(
          result.routing_ok
            ? 'Domain verified and live.'
            : 'Domain verified. Add the routing record below so it starts serving.',
          'success',
        );
      } else if (result.throttled) {
        toast('Please wait a few seconds before checking again.', 'info');
      } else {
        toast(DOMAIN_ERROR_COPY[result.error ?? ''] ?? 'Verification is not complete yet.', 'error');
      }
    } catch (e) {
      toast(errorMessage(e, 'Could not verify the domain.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleAssign = async (d: LandingDomain, value: string) => {
    setBusyId(d.id);
    try {
      replace(await setLandingDomainPage(ownerId, d.id, value || null));
    } catch (e) {
      toast(errorMessage(e, 'Could not change the page.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async () => {
    if (!toRemove) return;
    try {
      await removeLandingDomain(toRemove.id);
      onDomainsChange(domains.filter((d) => d.id !== toRemove.id));
      toast('Domain removed.', 'success');
    } catch (e) {
      toast(errorMessage(e, 'Could not remove the domain.'), 'error');
    } finally {
      setToRemove(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-base font-semibold text-text-primary">Connect a custom domain</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Serve a landing page on your own domain, like book.yourbusiness.com.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
          <Input
            aria-label="Domain"
            placeholder="book.yourbusiness.com"
            value={input}
            error={inputError}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
          />
          <select
            aria-label="Landing page to serve"
            className={selectCls}
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
          >
            <option value="">Choose a page later</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <Button onClick={handleAdd} disabled={adding || !input.trim()}>
            {adding && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Add domain
          </Button>
        </div>
      </div>

      {domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No custom domains connected"
          description="Add a domain above to serve a landing page on your own brand."
        />
      ) : (
        <ul className="space-y-4">
          {domains.map((d) => (
            <li key={d.id} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-text-primary">{d.domain}</h3>
                  <StatusBadge status={d.status} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleVerify(d)} disabled={busyId === d.id}>
                    {busyId === d.id ? (
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw size={14} aria-hidden="true" />
                    )}
                    Verify
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setToRemove(d)} aria-label={`Remove ${d.domain}`}>
                    <Trash2 size={14} className="text-danger" aria-hidden="true" />
                  </Button>
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor={`dom-page-${d.id}`} className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Serves this page
                </label>
                <select
                  id={`dom-page-${d.id}`}
                  className={selectCls}
                  value={d.landing_page_id ?? ''}
                  disabled={busyId === d.id}
                  onChange={(e) => void handleAssign(d, e.target.value)}
                >
                  <option value="">— None —</option>
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                      {p.status !== 'published' ? ` (${p.status})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {d.last_error && (
                <p className="mt-3 flex items-start gap-2 text-sm text-warning-500" role="status">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {DOMAIN_ERROR_COPY[d.last_error] ?? 'Verification needs attention.'}
                </p>
              )}

              {d.status !== 'verified' ? (
                <div className="mt-4 space-y-3 rounded-xl bg-bg-tertiary p-4">
                  <p className="text-sm font-medium text-text-primary">1. Prove you own the domain — add a TXT record</p>
                  <RecordRow label="Name" value={txtRecordName(d.domain)} onCopy={copy} />
                  <RecordRow label="Value" value={txtRecordValue(d.verification_token)} onCopy={copy} />
                  <p className="pt-1 text-sm font-medium text-text-primary">2. Point the domain to Vireek</p>
                  <RecordRow label="CNAME" value={CNAME_TARGET} onCopy={copy} />
                  <p className="text-xs text-text-secondary">
                    Use the CNAME for subdomains (book.example.com). For a root domain (example.com) add an A record
                    pointing to {A_RECORD} instead. Then click Verify.
                  </p>
                </div>
              ) : (
                <p className="mt-4 flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 size={16} aria-hidden="true" /> Ownership verified
                  {d.verified_at ? ` on ${new Date(d.verified_at).toLocaleDateString()}` : ''}.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!toRemove}
        title="Remove this domain?"
        description={`${toRemove?.domain ?? 'This domain'} will stop serving your landing page immediately.`}
        confirmLabel="Yes, remove it"
        onConfirm={handleRemove}
        onCancel={() => setToRemove(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------
// Analytics
// ------------------------------------------------------------------

interface AnalyticsState {
  loading: boolean;
  error: string | null;
  rows: PageStats[];
  utm: UtmRow[];
  daily: DailyPoint[];
}

function AnalyticsPanel({
  pages,
  domains,
  enabled,
  toast,
}: {
  pages: LandingPage[];
  domains: LandingDomain[];
  enabled: boolean;
  toast: ToastFn;
}) {
  const [days, setDays] = useState(30);
  const [pageFilter, setPageFilter] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<AnalyticsState>({ loading: true, error: null, rows: [], utm: [], daily: [] });
  const requestId = useRef(0);

  const [linkPageId, setLinkPageId] = useState('');
  const [source, setSource] = useState('');
  const [medium, setMedium] = useState('');
  const [campaign, setCampaign] = useState('');

  useEffect(() => {
    if (!enabled) return;
    const id = ++requestId.current;
    const target = pageFilter === 'all' ? null : pageFilter;
    setData((d) => ({ ...d, loading: true, error: null }));
    Promise.all([fetchLandingAnalytics(days), fetchUtmBreakdown(target, days), fetchDailySeries(target, days)])
      .then(([rows, utm, daily]) => {
        if (id === requestId.current) setData({ loading: false, error: null, rows, utm, daily });
      })
      .catch((e: unknown) => {
        if (id === requestId.current) {
          setData((d) => ({ ...d, loading: false, error: errorMessage(e, 'Could not load analytics.') }));
        }
      });
  }, [enabled, days, pageFilter, refreshKey]);

  const totals = useMemo(() => {
    const rows = pageFilter === 'all' ? data.rows : data.rows.filter((r) => r.landing_page_id === pageFilter);
    const sum = rows.reduce(
      (acc, r) => ({
        visitors: acc.visitors + r.visitors,
        clicks: acc.clicks + r.cta_clicks,
        leads: acc.leads + r.leads,
        bookings: acc.bookings + r.bookings,
      }),
      { visitors: 0, clicks: 0, leads: 0, bookings: 0 },
    );
    return { ...sum, rate: conversionRate(sum.leads + sum.bookings, sum.visitors) };
  }, [data.rows, pageFilter]);

  const maxVisitors = Math.max(1, ...data.daily.map((d) => d.visitors));
  const linkPage = pages.find((p) => p.id === linkPageId) ?? pages.find((p) => p.status === 'published');
  const trackedLink = linkPage
    ? buildTrackedLink(getPageUrl(linkPage, domains, window.location.origin), { source, medium, campaign })
    : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-3">
          <select
            aria-label="Date range"
            className={`${selectCls} !w-auto`}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <select
            aria-label="Landing page"
            className={`${selectCls} !w-auto`}
            value={pageFilter}
            onChange={(e) => setPageFilter(e.target.value)}
          >
            <option value="all">All pages</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={data.loading}>
          <RefreshCw size={14} className={data.loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </Button>
      </div>

      {data.error ? (
        <ErrorPanel message={data.error} onRetry={() => setRefreshKey((k) => k + 1)} />
      ) : data.loading && data.rows.length === 0 ? (
        <SectionSkeleton />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="Visitors" value={totals.visitors.toLocaleString()} />
            <StatTile label="CTA clicks" value={totals.clicks.toLocaleString()} />
            <StatTile label="Leads" value={totals.leads.toLocaleString()} />
            <StatTile label="Bookings" value={totals.bookings.toLocaleString()} />
            <StatTile label="Conversion" value={formatRate(totals.rate)} />
          </dl>

          {totals.visitors === 0 && data.utm.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No traffic recorded in this period"
              description="Share a published page's link — visits, leads and bookings will appear here."
            />
          ) : (
            <>
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h3 className="text-sm font-semibold text-text-primary">Daily visitors</h3>
                <div
                  className="mt-4 flex h-28 items-end gap-0.5"
                  role="img"
                  aria-label={`Daily visitors over the last ${days} days`}
                >
                  {data.daily.map((d) => (
                    <div
                      key={d.day}
                      className="flex-1 rounded-t bg-accent/70"
                      style={{ height: `${Math.max(2, (d.visitors / maxVisitors) * 100)}%` }}
                      title={`${d.day}: ${d.visitors} visitors, ${d.conversions} conversions`}
                    />
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <h3 className="text-sm font-semibold text-text-primary">Traffic sources &amp; campaigns</h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="text-xs text-text-secondary">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Source</th>
                        <th className="py-2 pr-3 font-medium">Medium</th>
                        <th className="py-2 pr-3 font-medium">Campaign</th>
                        <th className="py-2 pr-3 text-right font-medium">Visitors</th>
                        <th className="py-2 pr-3 text-right font-medium">Leads</th>
                        <th className="py-2 pr-3 text-right font-medium">Bookings</th>
                        <th className="py-2 text-right font-medium">Conv.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.utm.map((r, i) => (
                        <tr key={`${r.utm_source}-${r.utm_medium}-${r.utm_campaign}-${i}`}>
                          <td className="py-2.5 pr-3 text-text-primary">{r.utm_source}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{r.utm_medium}</td>
                          <td className="py-2.5 pr-3 text-text-secondary">{r.utm_campaign}</td>
                          <td className="py-2.5 pr-3 text-right">{r.visitors}</td>
                          <td className="py-2.5 pr-3 text-right">{r.leads}</td>
                          <td className="py-2.5 pr-3 text-right">{r.bookings}</td>
                          <td className="py-2.5 text-right">{formatRate(conversionRate(r.leads + r.bookings, r.visitors))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 className="text-sm font-semibold text-text-primary">Campaign link builder</h3>
        <p className="mt-1 text-xs text-text-secondary">Tag your ads and posts so every lead is attributed.</p>
        {linkPage ? (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="utm-page" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Page
                </label>
                <select
                  id="utm-page"
                  className={selectCls}
                  value={linkPage.id}
                  onChange={(e) => setLinkPageId(e.target.value)}
                >
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </div>
              <Input label="Source" placeholder="google" value={source} onChange={(e) => setSource(e.target.value)} />
              <Input label="Medium" placeholder="cpc" value={medium} onChange={(e) => setMedium(e.target.value)} />
              <Input
                label="Campaign"
                placeholder="spring-promo"
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
              />
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-primary">
                {trackedLink}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => toast((await copyToClipboard(trackedLink)) ? 'Link copied.' : 'Could not copy.', 'info')}
              >
                <Copy size={14} aria-hidden="true" /> Copy link
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-text-secondary">Create a landing page to build tracked links.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export function LandingPagesPage() {
  const { isOwner, permissions, profile, teamMember } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_edit_business_profile;
  // Same derivation as CallsPage/CalendarPage: data is keyed by the OWNER's id.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [tab, setTab] = useState<Tab>('pages');
  const [pages, setPages] = useState<LandingPage[]>([]);
  const [domains, setDomains] = useState<LandingDomain[]>([]);
  const [stats, setStats] = useState<Map<string, PageStats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LandingPage | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<LandingPage | null>(null);

  const loadAll = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [p, d, s] = await Promise.all([
        listLandingPages(accountOwnerId),
        listLandingDomains(accountOwnerId),
        fetchLandingAnalytics(30).catch(() => [] as PageStats[]), // stats are a bonus; never block the list
      ]);
      setPages(p);
      setDomains(d);
      setStats(new Map(s.map((row) => [row.landing_page_id, row])));
    } catch (e) {
      setLoadError(errorMessage(e, 'Could not load your landing pages.'));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const origin = window.location.origin;

  const handleToggle = async (page: LandingPage) => {
    if (!accountOwnerId) return;
    setBusyId(page.id);
    try {
      const next = await setLandingPageStatus(accountOwnerId, page.id, page.status === 'published' ? 'draft' : 'published');
      setPages((list) => list.map((p) => (p.id === next.id ? next : p)));
      toast(next.status === 'published' ? 'Page published.' : 'Page unpublished.', 'success');
    } catch (e) {
      toast(errorMessage(e, 'Could not update the page.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!accountOwnerId || !toDelete) return;
    try {
      await deleteLandingPage(accountOwnerId, toDelete.id);
      setPages((list) => list.filter((p) => p.id !== toDelete.id));
      toast('Landing page deleted.', 'success');
    } catch (e) {
      toast(errorMessage(e, 'Could not delete the page.'), 'error');
    } finally {
      setToDelete(null);
    }
  };

  const handleCopy = async (page: LandingPage) => {
    const ok = await copyToClipboard(getPageUrl(page, domains, origin));
    toast(ok ? 'Link copied.' : 'Could not copy the link.', ok ? 'success' : 'error');
  };

  // ---- permission gate ----
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Landing Pages">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Landing pages are restricted. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const tabs: { id: Tab; label: string; icon: typeof Globe }[] = [
    { id: 'pages', label: 'Pages', icon: LayoutTemplate },
    { id: 'domains', label: 'Domains', icon: Globe },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  ];

  return (
    <DashboardLayout activeLabel="Landing Pages">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Landing Pages</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Build landing and booking pages, serve them on your own domain, and see what converts.
          </p>
        </div>
        {!editing && tab === 'pages' && accountOwnerId && (
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} aria-hidden="true" /> New page
          </Button>
        )}
      </div>

      {editing && accountOwnerId ? (
        <PageEditor
          initial={editing === 'new' ? null : editing}
          ownerId={accountOwnerId}
          toast={toast}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setPages((list) => (list.some((p) => p.id === saved.id) ? list.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...list]));
            setEditing(null);
          }}
        />
      ) : (
        <>
          <div className="mb-6 overflow-x-auto" role="tablist" aria-label="Landing page sections">
            <div className="inline-flex min-w-full gap-1 rounded-xl bg-bg-tertiary p-1 sm:min-w-0">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`focus-ring flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors sm:flex-none ${
                    tab === id ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Icon size={15} aria-hidden="true" /> {label}
                </button>
              ))}
            </div>
          </div>

          {loadError ? (
            <ErrorPanel message={loadError} onRetry={() => void loadAll()} />
          ) : loading ? (
            <SectionSkeleton />
          ) : tab === 'pages' ? (
            pages.length === 0 ? (
              <EmptyState
                icon={LayoutTemplate}
                title="Create your first landing page"
                description="Capture leads and bookings from ads, social posts and QR codes — with full UTM tracking."
                action={{ label: 'New page', onClick: () => setEditing('new') }}
              />
            ) : (
              <ul className="space-y-4">
                {pages.map((p) => (
                  <PageCard
                    key={p.id}
                    page={p}
                    url={getPageUrl(p, domains, origin)}
                    stats={stats.get(p.id)}
                    busy={busyId === p.id}
                    onEdit={() => setEditing(p)}
                    onToggle={() => void handleToggle(p)}
                    onDelete={() => setToDelete(p)}
                    onCopy={() => void handleCopy(p)}
                  />
                ))}
              </ul>
            )
          ) : tab === 'domains' && accountOwnerId ? (
            <DomainsPanel ownerId={accountOwnerId} pages={pages} domains={domains} onDomainsChange={setDomains} toast={toast} />
          ) : (
            <AnalyticsPanel pages={pages} domains={domains} enabled={tab === 'analytics'} toast={toast} />
          )}
        </>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="Delete this landing page?"
        description={`"${toDelete?.title ?? 'This page'}" and its analytics will be permanently deleted. Any domain pointing to it will stop serving.`}
        confirmPhrase="delete this page"
        confirmLabel="Yes, delete this page"
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </DashboardLayout>
  );
}
