import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Globe,
  Inbox,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  SIGNATURE_MAX,
  STATUS_LABEL,
  addSenderDomain,
  canManageEmailSettings,
  dnsRecordToText,
  fetchEmailSettings,
  previewFromAddress,
  removeSenderDomain,
  rotateInboundAddress,
  saveEmailSettings,
  validateDomain,
  validateLocalPart,
  validateReplyTo,
  validateSignature,
  verifySenderDomain,
  type DnsRecord,
  type DomainStatus,
  type EmailSettingsInput,
  type EmailSettingsState,
} from '@/lib/emailSettings';

// Scoping note: every read/write goes through the email-settings edge function,
// which resolves the ACCOUNT OWNER id (accountOwnerId) server-side, so a team
// member with the permission edits the same settings row as the owner.

const EMPTY_FORM: EmailSettingsInput = {
  replyTo: '',
  signature: '',
  senderName: '',
  senderLocalPart: 'hello',
  inboundEnabled: true,
};

function formFromState(state: EmailSettingsState | null): EmailSettingsInput {
  const s = state?.settings;
  if (!s) return EMPTY_FORM;
  return {
    replyTo: s.reply_to_email ?? '',
    signature: s.signature ?? '',
    senderName: s.sender_name ?? '',
    senderLocalPart: s.sender_local_part,
    inboundEnabled: s.inbound_enabled,
  };
}

function StatusPill({ status }: { status: DomainStatus }) {
  const map: Record<DomainStatus, { cls: string; Icon: typeof Check }> = {
    verified: { cls: 'bg-success/10 text-success', Icon: CheckCircle2 },
    pending: { cls: 'bg-warning-500/10 text-warning-500', Icon: Clock },
    failed: { cls: 'bg-danger/10 text-danger', Icon: XCircle },
    not_started: { cls: 'bg-bg-tertiary text-text-secondary', Icon: Clock },
  };
  const { cls, Icon } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      <Icon size={12} aria-hidden="true" /> {STATUS_LABEL[status]}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the value is still selectable on screen */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="focus-ring inline-flex h-9 min-w-[36px] shrink-0 items-center justify-center rounded-lg border border-border bg-bg-primary px-2 text-text-secondary transition-colors hover:text-text-primary"
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

function DnsRecordRow({ record }: { record: DnsRecord }) {
  const fields: { label: string; value: string }[] = [
    { label: 'Type', value: record.priority != null ? `${record.type} (priority ${record.priority})` : record.type },
    { label: 'Host / Name', value: record.name },
    { label: 'Value', value: record.value },
  ];
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary">{record.kind}</span>
        <StatusPill status={record.status} />
      </div>
      <dl className="space-y-2.5">
        {fields.map((f) => (
          <div key={f.label} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-text-secondary">{f.label}</dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-text-primary">{f.value}</dd>
            </div>
            {f.label !== 'Type' && <CopyButton text={f.value} label={f.label} />}
          </div>
        ))}
      </dl>
    </li>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading email settings">
      <SkeletonCard rows={4} />
      <SkeletonCard rows={3} />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

export function EmailSettingsPage() {
  const { isOwner, permissions, profile, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const allowed = canManageEmailSettings(isOwner, permissions);

  const [state, setState] = useState<EmailSettingsState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | undefined>();
  const [form, setForm] = useState<EmailSettingsInput>(EMPTY_FORM);
  const [domainInput, setDomainInput] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'add' | 'verify' | 'remove' | 'rotate'>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirm, setConfirm] = useState<null | 'remove' | 'rotate'>(null);

  const applyState = useCallback((next: EmailSettingsState) => {
    setState(next);
    setForm(formFromState(next));
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      applyState(await fetchEmailSettings());
      setStatus('ready');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : undefined);
      setStatus('error');
    }
  }, [applyState]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const baseline = useMemo(() => formFromState(state), [state]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  const errors = {
    replyTo: validateReplyTo(form.replyTo),
    senderLocalPart: validateLocalPart(form.senderLocalPart),
    signature: validateSignature(form.signature),
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const settings = state?.settings ?? null;

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<EmailSettingsState>, success: string) => {
    setBusy(kind);
    try {
      applyState(await fn());
      toast(success, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    setShowErrors(true);
    if (hasErrors) return;
    await run('save', () => saveEmailSettings(form), 'Email settings saved.');
  };

  const handleAddDomain = async () => {
    const err = validateDomain(domainInput);
    if (err) {
      toast(err, 'error');
      return;
    }
    if (await run('add', () => addSenderDomain(domainInput), 'Domain added — now add the DNS records below.')) setDomainInput('');
  };

  const fromPreview = previewFromAddress(settings, profile?.company_name ?? null);
  const signaturePreview = form.signature.trim();

  // ---------------- gates ----------------
  if (authLoading || profileLoading) {
    return (
      <DashboardLayout activeLabel="Settings">
        <PageSkeleton />
      </DashboardLayout>
    );
  }

  if (!allowed) {
    return (
      <DashboardLayout activeLabel="Settings">
        <EmptyState
          icon={Lock}
          title="You don't have access to email settings"
          description="Only the account owner or team members who can edit the business profile can change how email is sent and received."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mx-auto max-w-3xl pb-28">
        <BackButton fallback="/dashboard/settings" />
        <div className="mb-6 mt-2">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Mail size={22} aria-hidden="true" /> Email settings
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Control how your replies look, where customer answers go, and which domain your email is sent from.
          </p>
        </div>

        {status === 'loading' && <PageSkeleton />}

        {status === 'error' && (
          <EmptyStateError icon={Mail} title="Couldn't load email settings" description={errorText} onRetry={load} />
        )}

        {status === 'ready' && state && (
          <div className="space-y-6">
            {!state.platform.emailConfigured && (
              <div role="status" className="flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4 text-sm text-text-primary">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                <p>Email sending isn't configured on this workspace yet, so domain verification and replies are unavailable. Contact support to enable it.</p>
              </div>
            )}

            {/* ---------- Sender identity & reply-to ---------- */}
            <Card className="space-y-5 p-5 sm:p-8">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Sender &amp; reply-to</h2>
                <p className="mt-1 text-sm text-text-secondary">What customers see in the From line, and where their replies are delivered.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Sender name"
                  value={form.senderName}
                  maxLength={80}
                  placeholder={profile?.company_name ?? 'Your business name'}
                  helperText="Defaults to your business name."
                  onChange={(e) => setForm((f) => ({ ...f, senderName: e.target.value }))}
                />
                <Input
                  label="Sender address"
                  value={form.senderLocalPart}
                  maxLength={64}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  error={showErrors ? (errors.senderLocalPart ?? undefined) : undefined}
                  helperText={
                    settings?.sender_domain && settings.domain_status === 'verified'
                      ? `Sends from ${form.senderLocalPart || 'hello'}@${settings.sender_domain}`
                      : 'Applies once your sender domain is verified.'
                  }
                  onChange={(e) => setForm((f) => ({ ...f, senderLocalPart: e.target.value }))}
                />
              </div>
              <Input
                label="Reply-to address"
                type="email"
                inputMode="email"
                value={form.replyTo}
                maxLength={254}
                placeholder="Leave empty to keep replies in your Vireek inbox"
                error={showErrors ? (errors.replyTo ?? undefined) : undefined}
                helperText={
                  form.replyTo.trim()
                    ? 'Customer replies will go to this address and will NOT appear in your Vireek inbox.'
                    : 'Replies come back into your Vireek inbox so the conversation stays in one place.'
                }
                onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))}
              />
              <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-xs text-text-secondary">
                <span className="font-semibold text-text-primary">Customers will see: </span>
                <span className="break-all font-mono">{fromPreview}</span>
              </p>
            </Card>

            {/* ---------- Signature ---------- */}
            <Card className="space-y-4 p-5 sm:p-8">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Signature</h2>
                <p className="mt-1 text-sm text-text-secondary">Added to the end of every email you send from the inbox. Plain text only.</p>
              </div>
              <Textarea
                label="Signature text"
                rows={5}
                value={form.signature}
                placeholder={'Thanks,\nThe team at Your Business\n(555) 123-4567'}
                error={showErrors ? (errors.signature ?? undefined) : undefined}
                helperText={`${form.signature.length}/${SIGNATURE_MAX}`}
                onChange={(e) => setForm((f) => ({ ...f, signature: e.target.value }))}
              />
              {signaturePreview && (
                <div className="rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Preview</p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-primary">{signaturePreview}</p>
                </div>
              )}
            </Card>

            {/* ---------- Sender domain ---------- */}
            <Card className="space-y-5 p-5 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
                    <Globe size={18} aria-hidden="true" /> Sender domain
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Verify your own domain so email comes from you and lands in the inbox, not spam.
                  </p>
                </div>
                {settings?.sender_domain && <StatusPill status={settings.domain_status} />}
              </div>

              {!settings?.sender_domain ? (
                <div className="space-y-3">
                  <Input
                    label="Domain"
                    value={domainInput}
                    placeholder="mail.yourcompany.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={!state.platform.emailConfigured}
                    helperText="Use a subdomain (like mail.yourcompany.com) to keep your main email unaffected."
                    onChange={(e) => setDomainInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleAddDomain();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddDomain}
                    disabled={busy !== null || !domainInput.trim() || !state.platform.emailConfigured}
                  >
                    {busy === 'add' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Globe size={16} aria-hidden="true" />}
                    Add domain
                  </Button>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="break-all font-mono text-sm font-semibold text-text-primary">{settings.sender_domain}</span>
                    <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                      SPF <StatusPill status={settings.spf_status} />
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                      DKIM <StatusPill status={settings.dkim_status} />
                    </span>
                  </div>

                  {settings.domain_status === 'verified' ? (
                    <p className="flex items-start gap-2 rounded-xl bg-success/10 px-4 py-3 text-sm text-text-primary">
                      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                      Your domain is verified. Emails are now sent from {settings.sender_local_part}@{settings.sender_domain}.
                    </p>
                  ) : (
                    <p className="text-sm text-text-secondary">
                      Add these records at your DNS provider, then press <span className="font-semibold text-text-primary">Check status</span>. DNS changes can take from a few minutes up to 48 hours.
                      {settings.domain_status === 'failed' && ' The last check failed — make sure each value was copied exactly, with no extra spaces.'}
                    </p>
                  )}

                  {settings.dns_records.length > 0 ? (
                    <ul className="space-y-3" aria-label="DNS records to add">
                      {settings.dns_records.map((r, i) => (
                        <DnsRecordRow key={`${r.kind}-${r.type}-${r.name}-${i}`} record={r} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-text-secondary">No DNS records returned yet — press Check status to refresh.</p>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" size="sm" onClick={() => run('verify', verifySenderDomain, 'Domain status updated.')} disabled={busy !== null}>
                      {busy === 'verify' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                      Check status
                    </Button>
                    {settings.dns_records.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(settings.dns_records.map(dnsRecordToText).join('\n')).then(
                            () => toast('DNS records copied.', 'success'),
                            () => toast('Could not access the clipboard.', 'error'),
                          );
                        }}
                      >
                        <Copy size={16} aria-hidden="true" /> Copy all
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm('remove')} disabled={busy !== null}>
                      <Trash2 size={16} aria-hidden="true" /> Remove domain
                    </Button>
                  </div>
                  {settings.domain_checked_at && (
                    <p className="text-xs text-text-secondary">Last checked {new Date(settings.domain_checked_at).toLocaleString()}</p>
                  )}
                </div>
              )}
            </Card>

            {/* ---------- Inbound ---------- */}
            <Card className="space-y-5 p-5 sm:p-8">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
                  <Inbox size={18} aria-hidden="true" /> Inbound email address
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Customer replies sent to this address appear in your Vireek inbox. It's used as the default reply-to.
                </p>
              </div>

              {state.inboundAddress ? (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
                  <code className="min-w-0 flex-1 break-all text-sm text-text-primary">{state.inboundAddress}</code>
                  <CopyButton text={state.inboundAddress} label="inbound address" />
                </div>
              ) : (
                <p className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
                  {state.platform.inboundConfigured
                    ? 'Your inbound address is being prepared — refresh in a moment.'
                    : "Inbound email isn't configured on this workspace yet."}
                </p>
              )}

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="focus-ring mt-1 h-4 w-4 rounded border-border accent-[var(--color-accent,#2563eb)]"
                  checked={form.inboundEnabled}
                  onChange={(e) => setForm((f) => ({ ...f, inboundEnabled: e.target.checked }))}
                />
                <span>
                  <span className="block text-sm font-medium text-text-primary">Accept inbound email</span>
                  <span className="block text-xs text-text-secondary">When off, messages sent to your address are discarded and won't create conversations.</span>
                </span>
              </label>

              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirm('rotate')} disabled={busy !== null || !state.inboundAddress}>
                <RefreshCw size={16} aria-hidden="true" /> Generate new address
              </Button>
            </Card>
          </div>
        )}
      </div>

      {/* Sticky save bar */}
      {status === 'ready' && (
        <div
          className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-secondary/95 px-4 py-3 backdrop-blur transition-transform duration-200 lg:left-60 print:hidden ${
            dirty ? 'translate-y-0' : 'translate-y-full'
          }`}
          aria-hidden={!dirty}
        >
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" tabIndex={dirty ? 0 : -1} onClick={() => { setForm(baseline); setShowErrors(false); }} disabled={busy !== null}>
                Discard
              </Button>
              <Button type="button" size="sm" tabIndex={dirty ? 0 : -1} onClick={handleSave} disabled={busy !== null || (showErrors && hasErrors)}>
                {busy === 'save' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'remove'}
        title="Remove sender domain?"
        description="Emails will go back to being sent from Vireek's shared address until you verify a domain again."
        confirmLabel="Remove domain"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await run('remove', removeSenderDomain, 'Sender domain removed.');
        }}
      />
      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Generate a new inbound address?"
        description="Your current address will stop receiving email immediately. Anything customers already sent to it from older emails will no longer reach your inbox."
        confirmLabel="Generate new address"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await run('rotate', rotateInboundAddress, 'New inbound address generated.');
        }}
      />
    </DashboardLayout>
  );
}
