import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Globe,
  ImagePlus,
  Loader as Loader2,
  Mail,
  MessageSquare,
  Palette,
  RefreshCw,
  Save,
  Smartphone,
  Trash2,
  Undo2,
  XCircle,
  Lock,
  Paintbrush,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  COLOR_PRESETS,
  DEFAULT_FORM,
  LIMITS,
  LOGO_MIME_TYPES,
  brandCssVars,
  changedFields,
  contrastRatio,
  domainDnsRecords,
  fetchBrandSettings,
  formatFromHeader,
  formatSmsPreview,
  gradeContrast,
  hasErrors,
  isFormDirty,
  isHexColor,
  logBrandingChange,
  logoPublicUrl,
  normalizeDomain,
  normalizeHex,
  readableTextColor,
  removeLogo,
  saveBrandSettings,
  settingsToForm,
  uploadLogo,
  validateForm,
  validateLogoFile,
  verifyCustomDomain,
  type BrandForm,
  type BrandSettings,
  type DomainStatus,
  type PortalTheme,
} from '@/lib/branding';

// Card with the hover-lift removed and tighter padding — these are form
// sections, not clickable tiles.
const SECTION = '!p-5 sm:!p-6 hover:!translate-y-0 hover:!border-border/80';

// ============================================================
// Small pieces
// ============================================================

function SectionHeader({ icon: Icon, title, description }: { icon: typeof Palette; title: string; description: string }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon size={20} />
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        <p className="mt-0.5 text-sm text-text-secondary">{description}</p>
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Branding">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don&rsquo;t have access to branding</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Branding controls what your customers see. Ask the account owner to grant you the
          &ldquo;Edit business profile&rdquo; permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" aria-busy="true" aria-label="Loading branding settings">
      <div className="space-y-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className={SECTION}>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-4 h-10 w-full" />
            <Skeleton className="mt-3 h-10 w-2/3" />
          </Card>
        ))}
      </div>
      <Skeleton className="hidden h-96 w-full rounded-2xl lg:block" />
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  // Text box keeps what the user is typing; only valid hex is pushed upstream
  // on blur/commit, so half-typed values never flash the whole UI.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = (raw: string) => {
    const n = normalizeHex(raw);
    if (n) {
      onChange(n);
      setText(n);
    }
  };

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={isHexColor(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="focus-ring h-12 w-14 shrink-0 cursor-pointer rounded-xl border border-border bg-bg-primary p-1"
        />
        <Input
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = normalizeHex(e.target.value);
            if (n && e.target.value.replace('#', '').length === 6) onChange(n);
          }}
          onBlur={(e) => commit(e.target.value)}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          error={error}
          placeholder="#2563EB"
          className="font-mono uppercase"
        />
      </div>
    </div>
  );
}

function ContrastBadge({ background }: { background: string }) {
  const text = readableTextColor(background);
  const ratio = contrastRatio(background, text);
  const grade = gradeContrast(ratio);
  const ok = grade === 'AAA' || grade === 'AA';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok ? 'bg-success-500/10 text-success' : 'bg-warning-500/10 text-warning-500'
      }`}
    >
      {ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
      Button text contrast {ratio.toFixed(1)}:1 · {grade === 'fail' ? 'too low' : grade}
    </span>
  );
}

const DOMAIN_BADGE: Record<DomainStatus, { label: string; cls: string; icon: typeof Clock }> = {
  unconfigured: { label: 'Not set up', cls: 'bg-bg-tertiary text-text-secondary', icon: Globe },
  pending: { label: 'Waiting for DNS', cls: 'bg-warning-500/10 text-warning-500', icon: Clock },
  verified: { label: 'Verified', cls: 'bg-success-500/10 text-success', icon: CheckCircle2 },
  failed: { label: 'Not verified', cls: 'bg-danger/10 text-danger', icon: XCircle },
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Couldn’t copy — select the value and copy it manually.', 'error');
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
    >
      {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
    </button>
  );
}

// ============================================================
// Live previews
// ============================================================

function PreviewShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
      {children}
    </div>
  );
}

function PortalPreview({ form, logoUrl, businessName }: { form: BrandForm; logoUrl: string | null; businessName: string }) {
  const vars = brandCssVars(form.primary_color, form.accent_color) as React.CSSProperties;
  const dark = form.portal_theme === 'dark';
  const bg = dark ? '#0B1220' : '#FFFFFF';
  const fg = dark ? '#E5E7EB' : '#0F172A';
  const muted = dark ? '#94A3B8' : '#64748B';
  const line = dark ? '#1F2A3D' : '#E2E8F0';
  const title = form.portal_welcome_title.trim() || `Welcome to ${businessName}`;
  const message = form.portal_welcome_message.trim() || 'View your jobs, quotes and equipment — all in one place.';
  return (
    <div className="overflow-hidden rounded-xl border border-border" style={{ ...vars, background: bg, color: fg }}>
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: 'var(--brand-primary)', color: 'var(--brand-on-primary)' }}>
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-7 max-w-[120px] rounded object-contain" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/20 text-xs font-bold">
            {businessName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="truncate text-sm font-semibold">{businessName}</span>
      </div>
      <div className="space-y-3 p-4">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: muted }}>{message}</p>
        </div>
        <div className="flex gap-2">
          <span className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--brand-accent)', color: 'var(--brand-on-accent)' }}>
            Request service
          </span>
          <span className="rounded-lg border px-3 py-1.5 text-xs font-medium" style={{ borderColor: line }}>
            My jobs
          </span>
        </div>
        {form.portal_show_powered_by && (
          <p className="pt-1 text-[10px]" style={{ color: muted }}>Powered by Vireek</p>
        )}
      </div>
    </div>
  );
}

function EmailPreview({ form, logoUrl, businessName }: { form: BrandForm; logoUrl: string | null; businessName: string }) {
  const from = formatFromHeader(form.email_sender_name, businessName);
  const vars = brandCssVars(form.primary_color, form.accent_color) as React.CSSProperties;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-primary text-xs" style={vars}>
      <div className="space-y-1 border-b border-border px-4 py-3">
        <p className="text-text-secondary">
          From: <span className="font-medium text-text-primary">{from}</span>
        </p>
        {form.email_reply_to.trim() && (
          <p className="text-text-secondary">
            Reply-to: <span className="text-text-primary">{form.email_reply_to.trim()}</span>
          </p>
        )}
        <p className="text-text-secondary">
          Subject: <span className="font-medium text-text-primary">Your appointment is confirmed</span>
        </p>
      </div>
      <div className="space-y-3 px-4 py-4">
        {logoUrl && <img src={logoUrl} alt="" className="h-8 max-w-[140px] object-contain" />}
        <p className="text-text-primary">Hi Alex, your technician is scheduled for Tuesday between 9 and 11 AM.</p>
        <span className="inline-block rounded-lg px-3 py-1.5 font-semibold" style={{ background: 'var(--brand-primary)', color: 'var(--brand-on-primary)' }}>
          View appointment
        </span>
        {form.email_footer.trim() && (
          <p className="whitespace-pre-line border-t border-border pt-3 text-text-secondary">{form.email_footer.trim()}</p>
        )}
      </div>
    </div>
  );
}

function SmsPreview({ form }: { form: BrandForm }) {
  const text = formatSmsPreview(form.sms_sender_label, 'Your technician is on the way — ETA 20 min.');
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-bl-md bg-bg-tertiary px-3.5 py-2.5 text-sm text-text-primary">{text}</div>
      <p className="mt-2 text-[11px] text-text-secondary">Sent from your business number</p>
    </div>
  );
}

// ============================================================
// Main page
// ============================================================

export function BrandingSettingsPage() {
  const { profile, profileLoading, isOwner, permissions, teamMember, user } = useAuth();
  const { toast } = useToast();

  // Same scoping rule used by NotificationsContext: branding belongs to the
  // ACCOUNT OWNER, so a team member must read/write the owner's row — never
  // one keyed by their own user id.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_edit_business_profile;
  const businessName = profile?.company_name?.trim() || 'Your business';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saved, setSaved] = useState<BrandSettings | null>(null);
  const [form, setForm] = useState<BrandForm>(DEFAULT_FORM);
  const [baseline, setBaseline] = useState<BrandForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [confirmRemoveLogo, setConfirmRemoveLogo] = useState(false);
  const [previewTab, setPreviewTab] = useState<'portal' | 'email' | 'sms'>('portal');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const row = await fetchBrandSettings(accountOwnerId);
      const f = settingsToForm(row);
      setSaved(row);
      setForm(f);
      setBaseline(f);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  const errors = useMemo(() => validateForm(form), [form]);
  const dirty = useMemo(() => isFormDirty(form, baseline), [form, baseline]);
  const logoUrl = useMemo(() => logoPublicUrl(saved?.logo_path ?? null), [saved?.logo_path]);

  // Warn before losing unsaved edits (tab close / refresh).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const set = <K extends keyof BrandForm>(key: K, value: BrandForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    if (!accountOwnerId || saving) return;
    if (hasErrors(errors)) {
      toast('Fix the highlighted fields before saving.', 'error');
      return;
    }
    setSaving(true);
    try {
      const row = await saveBrandSettings(accountOwnerId, form);
      const changed = changedFields(form, baseline);
      const f = settingsToForm(row);
      setSaved(row);
      setForm(f);
      setBaseline(f);
      void logBrandingChange(profile?.email ?? user?.email ?? null, changed);
      toast('Branding saved.', 'success');
    } catch (err) {
      const code = (err as { code?: string })?.code;
      toast(
        code === '23505'
          ? 'That domain is already verified by another account.'
          : 'Could not save your branding. Please try again.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || !accountOwnerId) return;
    const invalid = validateLogoFile(file);
    if (invalid) {
      toast(invalid, 'error');
      return;
    }
    setUploading(true);
    try {
      const row = await uploadLogo(accountOwnerId, file, saved?.logo_path ?? null);
      setSaved(row);
      toast('Logo updated.', 'success');
      void logBrandingChange(profile?.email ?? user?.email ?? null, ['logo']);
    } catch {
      toast('Could not upload that logo. Please try again.', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleRemoveLogo = async () => {
    if (!accountOwnerId) return;
    setConfirmRemoveLogo(false);
    setUploading(true);
    try {
      const row = await removeLogo(accountOwnerId, saved?.logo_path ?? null);
      setSaved(row);
      toast('Logo removed.', 'success');
      void logBrandingChange(profile?.email ?? user?.email ?? null, ['logo']);
    } catch {
      toast('Could not remove the logo. Please try again.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const result = await verifyCustomDomain();
      if (accountOwnerId) setSaved(await fetchBrandSettings(accountOwnerId));
      if (result.status === 'verified') toast('Domain verified.', 'success');
      else toast(result.error ?? 'Not verified yet.', 'info');
    } catch {
      toast('Could not check the domain right now. Please try again.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  // ---------- gates ----------
  if (profileLoading) {
    return (
      <DashboardLayout activeLabel="Branding">
        <PageSkeleton />
      </DashboardLayout>
    );
  }
  if (!profile || !canManage) return <NoAccess />;

  const domainSavedMatches =
    saved?.custom_domain != null && saved.custom_domain === (normalizeDomain(form.custom_domain) || null);
  const domainStatus: DomainStatus = domainSavedMatches ? saved!.domain_status : form.custom_domain.trim() ? 'pending' : 'unconfigured';
  const badge = DOMAIN_BADGE[domainStatus];
  const BadgeIcon = badge.icon;
  const records = domainDnsRecords(form.custom_domain, domainSavedMatches ? saved!.domain_verification_token : null);
  const primaryValid = isHexColor(form.primary_color);

  const themeOptions: { id: PortalTheme; label: string }[] = [
    { id: 'auto', label: 'Match visitor' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  return (
    <DashboardLayout activeLabel="Branding">
      <BackButton fallback="/dashboard/settings" label="Back to settings" />

      <div className="mb-6 mt-4 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Paintbrush size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Branding</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Make every email, text and customer page look like your business.
          </p>
        </div>
      </div>

      {loading ? (
        <PageSkeleton />
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-dashed border-danger/40 bg-danger/5 px-6 py-14 text-center">
          <AlertTriangle size={28} className="text-danger" />
          <h3 className="mt-3 text-base font-semibold text-text-primary">Couldn&rsquo;t load your branding</h3>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">Check your connection and try again.</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
            <RefreshCw size={14} /> Retry
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 pb-24 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-6">
            {!saved && (
              <div className="flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4 text-sm text-text-secondary">
                <Palette size={18} className="mt-0.5 shrink-0 text-accent" />
                You haven&rsquo;t customized anything yet. Customers currently see Vireek&rsquo;s default look with your business name.
              </div>
            )}

            {/* Logo */}
            <Card className={SECTION}>
              <SectionHeader icon={ImagePlus} title="Logo" description="Shown in the customer portal and branded emails. PNG, JPG or WebP, up to 2 MB." />
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex h-20 w-40 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-bg-primary">
                  {logoUrl ? (
                    <img src={logoUrl} alt={`${businessName} logo`} className="max-h-16 max-w-[9rem] object-contain" />
                  ) : (
                    <span className="text-xs text-text-secondary">No logo</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept={LOGO_MIME_TYPES.join(',')}
                    className="sr-only"
                    aria-label="Upload logo file"
                    onChange={(e) => void handleFile(e.target.files?.[0])}
                  />
                  <Button variant="secondary" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                    {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
                    {logoUrl ? 'Replace logo' : 'Upload logo'}
                  </Button>
                  {logoUrl && (
                    <Button variant="ghost" size="sm" disabled={uploading} onClick={() => setConfirmRemoveLogo(true)}>
                      <Trash2 size={14} /> Remove
                    </Button>
                  )}
                </div>
              </div>
            </Card>

            {/* Colors */}
            <Card className={SECTION}>
              <SectionHeader icon={Palette} title="Brand colors" description="Primary is used for headers and main buttons; accent for highlights." />
              <div className="grid gap-4 sm:grid-cols-2">
                <ColorField id="brand-primary" label="Primary color" value={form.primary_color} onChange={(v) => set('primary_color', v)} error={errors.primary_color} />
                <ColorField id="brand-accent" label="Accent color" value={form.accent_color} onChange={(v) => set('accent_color', v)} error={errors.accent_color} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {primaryValid && <ContrastBadge background={form.primary_color} />}
              </div>
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-text-secondary">Presets</p>
                <div className="flex flex-wrap gap-2">
                  {COLOR_PRESETS.map((p) => {
                    const active = form.primary_color.toUpperCase() === p.primary && form.accent_color.toUpperCase() === p.accent;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setForm((f) => ({ ...f, primary_color: p.primary, accent_color: p.accent }))}
                        className={`focus-ring flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                          active ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/30'
                        }`}
                      >
                        <span className="flex">
                          <span className="h-4 w-4 rounded-full" style={{ background: p.primary }} />
                          <span className="-ml-1.5 h-4 w-4 rounded-full ring-2 ring-bg-secondary" style={{ background: p.accent }} />
                        </span>
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Card>

            {/* Email & SMS */}
            <Card className={SECTION}>
              <SectionHeader icon={Mail} title="Email & SMS identity" description="How messages from your business appear in a customer's inbox and phone." />
              <div className="space-y-4">
                <Input
                  label="Sender name"
                  value={form.email_sender_name}
                  onChange={(e) => set('email_sender_name', e.target.value)}
                  maxLength={LIMITS.senderName}
                  placeholder={businessName}
                  helperText="Shown as the “From” name. Leave blank to use your business name."
                  error={errors.email_sender_name}
                />
                <Input
                  label="Reply-to email"
                  type="email"
                  inputMode="email"
                  value={form.email_reply_to}
                  onChange={(e) => set('email_reply_to', e.target.value)}
                  maxLength={LIMITS.replyTo}
                  placeholder="office@yourcompany.com"
                  helperText="Where customer replies are sent."
                  error={errors.email_reply_to}
                />
                <Textarea
                  label="Email footer"
                  value={form.email_footer}
                  onChange={(e) => set('email_footer', e.target.value)}
                  maxLength={LIMITS.footer}
                  rows={3}
                  placeholder={'Licensed & insured · License #12345\n123 Main St, Austin, TX'}
                  helperText={`${form.email_footer.length}/${LIMITS.footer}`}
                />
                <Input
                  label="SMS prefix"
                  value={form.sms_sender_label}
                  onChange={(e) => set('sms_sender_label', e.target.value)}
                  maxLength={LIMITS.smsLabel}
                  placeholder={businessName.slice(0, LIMITS.smsLabel)}
                  helperText="Added to the start of each text so customers know who it's from."
                  error={errors.sms_sender_label}
                />
              </div>
            </Card>

            {/* Portal */}
            <Card className={SECTION}>
              <SectionHeader icon={Smartphone} title="Customer portal" description="The page customers open to see their jobs, quotes and equipment." />
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-text-primary">Theme</legend>
                <div className="inline-flex rounded-xl border border-border bg-bg-primary p-1" role="radiogroup" aria-label="Portal theme">
                  {themeOptions.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={form.portal_theme === o.id}
                      onClick={() => set('portal_theme', o.id)}
                      className={`focus-ring rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        form.portal_theme === o.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="mt-4 space-y-4">
                <Input
                  label="Welcome title"
                  value={form.portal_welcome_title}
                  onChange={(e) => set('portal_welcome_title', e.target.value)}
                  maxLength={LIMITS.welcomeTitle}
                  placeholder={`Welcome to ${businessName}`}
                />
                <Textarea
                  label="Welcome message"
                  value={form.portal_welcome_message}
                  onChange={(e) => set('portal_welcome_message', e.target.value)}
                  maxLength={LIMITS.welcomeMessage}
                  rows={3}
                  helperText={`${form.portal_welcome_message.length}/${LIMITS.welcomeMessage}`}
                />
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={form.portal_show_powered_by}
                    onChange={(e) => set('portal_show_powered_by', e.target.checked)}
                    className="focus-ring mt-1 h-4 w-4 rounded border-border"
                  />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">Show &ldquo;Powered by Vireek&rdquo;</span>
                    <span className="block text-xs text-text-secondary">Turn off for a fully white-labeled portal.</span>
                  </span>
                </label>
              </div>
            </Card>

            {/* Domain */}
            <Card className={SECTION}>
              <SectionHeader icon={Globe} title="Custom domain" description="Serve your customer portal from your own address, e.g. portal.yourcompany.com." />
              <Input
                label="Domain"
                value={form.custom_domain}
                onChange={(e) => set('custom_domain', e.target.value)}
                placeholder="portal.yourcompany.com"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                error={errors.custom_domain}
                helperText="Use a subdomain you control. Changing it restarts verification."
              />

              {form.custom_domain.trim() && !errors.custom_domain && (
                <div className="mt-5">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}>
                      <BadgeIcon size={12} /> {badge.label}
                    </span>
                    {domainSavedMatches && saved?.domain_verified_at && domainStatus === 'verified' && (
                      <span className="text-xs text-text-secondary">
                        since {new Date(saved.domain_verified_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {!domainSavedMatches ? (
                    <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                      Save your changes to generate the DNS records for this domain.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-2">
                        {records.map((r) => (
                          <div key={r.type} className="rounded-xl border border-border bg-bg-primary p-3">
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-text-primary">
                                {r.type} <span className="font-normal text-text-secondary">· {r.purpose}</span>
                              </span>
                            </div>
                            {([['Host', r.host], ['Value', r.value]] as const).map(([k, v]) => (
                              <div key={k} className="flex items-center gap-2">
                                <span className="w-11 shrink-0 text-xs text-text-secondary">{k}</span>
                                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-primary">{v}</code>
                                <CopyButton value={v} label={`${r.type} ${k.toLowerCase()}`} />
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      {saved?.domain_error && domainStatus !== 'verified' && (
                        <p role="alert" className="mt-3 text-sm text-danger">{saved.domain_error}</p>
                      )}
                      {domainStatus !== 'verified' && (
                        <Button variant="secondary" size="sm" className="mt-4" onClick={() => void handleVerify()} disabled={verifying || dirty}>
                          {verifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          {verifying ? 'Checking DNS…' : 'Check DNS records'}
                        </Button>
                      )}
                      {dirty && domainStatus !== 'verified' && (
                        <p className="mt-2 text-xs text-text-secondary">Save your changes first, then check DNS.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* Preview (sticky on desktop, stacked on mobile) */}
          <aside className="lg:sticky lg:top-6 lg:self-start" aria-label="Live preview">
            <Card className={SECTION}>
              <div className="mb-4 flex rounded-xl border border-border bg-bg-primary p-1" role="tablist" aria-label="Preview type">
                {([
                  ['portal', 'Portal', Smartphone],
                  ['email', 'Email', Mail],
                  ['sms', 'SMS', MessageSquare],
                ] as const).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={previewTab === id}
                    onClick={() => setPreviewTab(id)}
                    className={`focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                      previewTab === id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <Icon size={13} /> {label}
                  </button>
                ))}
              </div>
              <div role="tabpanel">
                {previewTab === 'portal' && (
                  <PreviewShell title="Customer portal">
                    <PortalPreview form={form} logoUrl={logoUrl} businessName={businessName} />
                  </PreviewShell>
                )}
                {previewTab === 'email' && (
                  <PreviewShell title="Email">
                    <EmailPreview form={form} logoUrl={logoUrl} businessName={businessName} />
                  </PreviewShell>
                )}
                {previewTab === 'sms' && (
                  <PreviewShell title="Text message">
                    <SmsPreview form={form} />
                  </PreviewShell>
                )}
              </div>
            </Card>
          </aside>
        </div>
      )}

      {/* Sticky save bar */}
      {!loading && !loadError && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-border bg-bg-secondary/95 p-3 shadow-card backdrop-blur-md sm:p-4 dark:shadow-card-dark">
          <p className="mr-auto text-sm text-text-secondary" aria-live="polite">
            {dirty ? 'You have unsaved changes' : 'All changes saved'}
          </p>
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setForm(baseline)}>
            <Undo2 size={14} /> Discard
          </Button>
          <Button size="sm" disabled={!dirty || saving || hasErrors(errors)} onClick={() => void handleSave()}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveLogo}
        title="Remove your logo?"
        description="Customers will see your business initial instead until you upload a new one."
        confirmLabel="Yes, remove it"
        onConfirm={handleRemoveLogo}
        onCancel={() => setConfirmRemoveLogo(false)}
      />
    </DashboardLayout>
  );
}
