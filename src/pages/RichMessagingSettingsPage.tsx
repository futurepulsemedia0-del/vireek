import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Clock, ShieldAlert, Smartphone, MessageSquare } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  FALLBACK_SECONDS,
  STATUS_LABEL,
  fetchRichAccount,
  requestRichAccess,
  saveRichSettings,
  validateSettings,
  type EditableSettings,
  type ProviderStatus,
  type RichAccount,
} from '@/lib/richMessaging';

function StatusBadge({ status }: { status: ProviderStatus }) {
  const Icon =
    status === 'approved'
      ? BadgeCheck
      : status === 'rejected' || status === 'suspended'
        ? ShieldAlert
        : Clock;
  const tone =
    status === 'approved'
      ? 'bg-success/10 text-success'
      : status === 'rejected' || status === 'suspended'
        ? 'bg-red-500/10 text-red-500'
        : 'bg-bg-tertiary text-text-secondary';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <Icon size={12} aria-hidden="true" /> {STATUS_LABEL[status]}
    </span>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

const inputCls =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary';

export function RichMessagingSettingsPage() {
  const { user } = useAuth();
  const [account, setAccount] = useState<RichAccount | null>(null);
  const [form, setForm] = useState<EditableSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const apply = (a: RichAccount | null) => {
    setAccount(a);
    setForm(
      a
        ? {
            rcsEnabled: a.rcsEnabled,
            ambEnabled: a.ambEnabled,
            brandName: a.brandName,
            brandLogoUrl: a.brandLogoUrl,
            brandColor: a.brandColor,
            fallbackToSms: a.fallbackToSms,
            fallbackAfterSeconds: a.fallbackAfterSeconds,
            attemptOnUnknown: a.attemptOnUnknown,
          }
        : null,
    );
  };

  const load = useCallback(async () => {
    try {
      apply(await fetchRichAccount());
    } catch (e) {
      setMessage({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Could not load settings.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const request = async () => {
    setBusy(true);
    setMessage(null);
    try {
      apply(await requestRichAccess());
      setMessage({
        tone: 'ok',
        text: 'Request received. Our team completes carrier and Apple approval and will enable the channels for you.',
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Request failed.' });
    }
    setBusy(false);
  };

  const save = async () => {
    if (!form || !user) return;
    const invalid = validateSettings(form);
    if (invalid) return setMessage({ tone: 'error', text: invalid });
    setBusy(true);
    setMessage(null);
    try {
      await saveRichSettings(user.id, form);
      await load();
      setMessage({ tone: 'ok', text: 'Settings saved.' });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Save failed.' });
    }
    setBusy(false);
  };

  const set = <K extends keyof EditableSettings>(k: K, v: EditableSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <DashboardLayout activeLabel="Inbox">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <Link
          to="/dashboard/inbox"
          className="focus-ring mb-4 inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft size={13} /> Back to inbox
        </Link>
        <h1 className="text-lg font-semibold text-text-primary">RCS &amp; Apple Messages</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Send booking confirmations, technician ETAs and pay-now cards as rich messages with your
          verified brand, with automatic SMS fallback for customers whose phone can&apos;t receive
          them. STOP replies are shared with SMS.
        </p>

        {message && (
          <p
            role="status"
            className={`mt-4 rounded-xl px-3.5 py-2.5 text-sm ${message.tone === 'ok' ? 'bg-success/10 text-success' : 'bg-red-500/10 text-red-500'}`}
          >
            {message.text}
          </p>
        )}

        {loading ? (
          <p className="mt-6 text-sm text-text-secondary">Loading…</p>
        ) : !account || !form ? (
          <div className="mt-6 rounded-2xl border border-border p-5">
            <p className="text-sm text-text-primary">
              Rich messaging is not set up for your account yet.
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              Requesting access starts provider approval: Google/carrier RCS agent verification and
              Apple Messages for Business registration.
            </p>
            <button
              type="button"
              onClick={request}
              disabled={busy}
              className="focus-ring mt-4 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Requesting…' : 'Request access'}
            </button>
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <section className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                    <Smartphone size={15} /> RCS Business Messaging
                  </h2>
                  <StatusBadge status={account.rcsStatus} />
                </div>
                <p className="mt-2 text-xs text-text-secondary">
                  Agent: {account.rcsAgentId ?? 'assigned after approval'}
                </p>
                <Toggle
                  label="Send via RCS"
                  hint="Only active once the agent is approved."
                  checked={form.rcsEnabled}
                  disabled={account.rcsStatus !== 'approved'}
                  onChange={(v) => set('rcsEnabled', v)}
                />
              </section>
              <section className="rounded-2xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                    <MessageSquare size={15} /> Apple Messages for Business
                  </h2>
                  <StatusBadge status={account.ambStatus} />
                </div>
                <p className="mt-2 text-xs text-text-secondary">
                  Business ID: {account.ambBusinessId ?? 'assigned after approval'}. Apple only lets
                  customers start the conversation.
                </p>
                <Toggle
                  label="Reply via Apple Messages"
                  checked={form.ambEnabled}
                  disabled={account.ambStatus !== 'approved'}
                  onChange={(v) => set('ambEnabled', v)}
                />
              </section>
            </div>

            <section className="mt-4 rounded-2xl border border-border p-4">
              <h2 className="text-sm font-semibold text-text-primary">Sender branding</h2>
              {account.verifiedSenderName && (
                <p className="mt-1 text-xs text-text-secondary">
                  Verified sender name: <strong>{account.verifiedSenderName}</strong>
                </p>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-text-secondary">
                  Brand name (used in SMS fallback)
                  <input
                    className={`${inputCls} mt-1`}
                    value={form.brandName}
                    maxLength={60}
                    onChange={(e) => set('brandName', e.target.value)}
                  />
                </label>
                <label className="text-xs text-text-secondary">
                  Brand colour
                  <input
                    className={`${inputCls} mt-1`}
                    value={form.brandColor}
                    placeholder="#1A2B3C"
                    onChange={(e) => set('brandColor', e.target.value)}
                  />
                </label>
                <label className="text-xs text-text-secondary sm:col-span-2">
                  Logo URL (https)
                  <input
                    className={`${inputCls} mt-1`}
                    value={form.brandLogoUrl}
                    placeholder="https://…/logo.png"
                    onChange={(e) => set('brandLogoUrl', e.target.value)}
                  />
                </label>
              </div>
              <p className="mt-2 text-[11px] text-text-secondary">
                The logo, name and colour customers see on their phone come from the verified agent
                registration; changes there go through provider review.
              </p>
            </section>

            <section className="mt-4 rounded-2xl border border-border p-4">
              <h2 className="text-sm font-semibold text-text-primary">Delivery &amp; fallback</h2>
              <Toggle
                label="Automatic SMS fallback"
                hint="If a rich message fails or isn't delivered in time, text it instead (A2P, opt-out and quiet-hours rules still apply)."
                checked={form.fallbackToSms}
                onChange={(v) => set('fallbackToSms', v)}
              />
              <Toggle
                label="Try RCS when support is unknown"
                hint="First message to a new number is attempted over RCS and falls back to SMS if needed."
                checked={form.attemptOnUnknown}
                onChange={(v) => set('attemptOnUnknown', v)}
              />
              <label className="mt-2 block text-xs text-text-secondary">
                Fall back after (seconds)
                <input
                  type="number"
                  className={`${inputCls} mt-1 max-w-[10rem]`}
                  min={FALLBACK_SECONDS.min}
                  max={FALLBACK_SECONDS.max}
                  value={form.fallbackAfterSeconds}
                  disabled={!form.fallbackToSms}
                  onChange={(e) => set('fallbackAfterSeconds', Number(e.target.value))}
                />
              </label>
            </section>

            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="focus-ring mt-5 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
