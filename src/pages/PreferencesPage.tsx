// Public, token-secured customer preference center (/preferences/:token). No login: the random token is the
// only credential and it is separate from the customer portal token. All access goes through the SECURITY
// DEFINER RPCs in 20270411000000_customer_communication_preferences.sql (masked contact info, audited writes).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, BellOff, CheckCircle2, Loader2, Mail, MessageSquare, Phone, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { fetchPreferences, savePreferences } from '@/lib/communicationPreferencesApi';
import {
  FREQUENCIES,
  LANGUAGES,
  applyUnsubscribeAll,
  describeOutcome,
  formFromRow,
  isDirty,
  isUuid,
  isValidForm,
  resubscribe,
  summarize,
  type PreferenceForm,
  type PreferenceFrequency,
  type PreferenceLanguage,
  type PreferenceRow,
} from '@/lib/communicationPreferences';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'missing' } | { kind: 'ready'; row: PreferenceRow };

function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  icon: Icon,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: typeof Mail;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && <Icon size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />}
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{label}</p>
          {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed ${
          checked ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
        }`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>
      <div className="mt-1 divide-y divide-border">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-start justify-center px-4 pb-28 pt-24 sm:items-center sm:py-24">{children}</main>
      <Footer />
    </div>
  );
}

export function PreferencesPage() {
  const { token } = useParams<{ token: string }>();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [saved, setSaved] = useState<PreferenceForm | null>(null);
  const [form, setForm] = useState<PreferenceForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  // Private link: keep it out of search engines.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const fetchRow = useCallback(async () => {
    if (!isUuid(token)) {
      setLoad({ kind: 'missing' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      const row = await fetchPreferences(token);
      if (!row) {
        setLoad({ kind: 'missing' });
        return;
      }
      const f = formFromRow(row);
      setSaved(f);
      setForm(f);
      setLoad({ kind: 'ready', row });
    } catch {
      setLoad({ kind: 'error' });
    }
  }, [token]);

  useEffect(() => {
    void fetchRow();
  }, [fetchRow]);

  const available = useMemo(
    () => (load.kind === 'ready' ? { phone: !!load.row.masked_phone, email: !!load.row.masked_email } : { phone: false, email: false }),
    [load],
  );

  const set = <K extends keyof PreferenceForm>(key: K, value: PreferenceForm[K]) => {
    setJustSaved(false);
    setError(null);
    // Touching any individual choice leaves the "unsubscribed from everything" state.
    setForm((f) => (f ? { ...f, [key]: value, unsubscribeAll: false } : f));
  };

  const dirty = !!form && !!saved && isDirty(form, saved);

  const submit = async (next: PreferenceForm) => {
    if (!isUuid(token) || saving || !isValidForm(next)) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await savePreferences(token, next);
      if (outcome === 'ok') {
        await fetchRow();
        setJustSaved(true);
        setConfirmAll(false);
      } else {
        setError(describeOutcome(outcome));
      }
    } catch {
      setError('Something went wrong saving your choices. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (load.kind === 'loading') {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading your preferences…
        </div>
      </Card>
    );
  }

  if (load.kind === 'error' || load.kind === 'missing') {
    const missing = load.kind === 'missing';
    return (
      <Card>
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark" role="status">
          <AlertCircle size={30} className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-text-primary">{missing ? 'Link not valid' : "We couldn't load your preferences"}</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {missing
              ? 'This preference link is incomplete or no longer valid. Please use the link from your most recent message, or contact the business directly.'
              : 'Check your connection and try again.'}
          </p>
          {!missing && (
            <div className="mt-5 flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => void fetchRow()}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </Card>
    );
  }

  const { row } = load;
  const f = form as PreferenceForm;
  const business = row.business_name?.trim() || 'this business';
  const noOptionalChannel = !f.sms && !f.email && !f.voice;

  return (
    <Card>
      <div className="w-full max-w-lg space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{business}</p>
          <h1 className="mt-1 text-2xl font-bold text-text-primary">
            {row.customer_first_name && row.customer_first_name !== '' ? `${row.customer_first_name}, ` : ''}how would you like to hear from us?
          </h1>
          <p className="mt-2 text-sm text-text-secondary">Your choices apply to messages from {business} only and take effect right away.</p>
        </div>

        {f.unsubscribeAll && (
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-bg-tertiary p-4" role="status">
            <BellOff size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-text-primary">You're unsubscribed from optional messages.</p>
              <button type="button" className="focus-ring mt-1 rounded text-accent underline" onClick={() => { setJustSaved(false); setForm(resubscribe(f, available)); }}>
                Turn messages back on
              </button>
            </div>
          </div>
        )}

        <Section title="How we contact you">
          <Switch
            icon={MessageSquare}
            label="Text messages"
            description={row.masked_phone ? `To ${row.masked_phone}` : 'No phone number on file'}
            checked={f.sms}
            disabled={!row.masked_phone}
            onChange={(v) => set('sms', v)}
          />
          <Switch
            icon={Mail}
            label="Email"
            description={row.masked_email ? `To ${row.masked_email}` : 'No email on file'}
            checked={f.email}
            disabled={!row.masked_email}
            onChange={(v) => set('email', v)}
          />
          <Switch
            icon={Phone}
            label="Phone calls"
            description={row.masked_phone ? `To ${row.masked_phone}` : 'No phone number on file'}
            checked={f.voice}
            disabled={!row.masked_phone}
            onChange={(v) => set('voice', v)}
          />
          {row.sms_blocked_by_stop && (
            <p className="py-3 text-xs text-text-secondary">
              You previously replied STOP, so texts stay off. To receive texts again, reply START to any message from us.
            </p>
          )}
        </Section>

        <Section title="What we send">
          <Switch label="Appointment reminders & job updates" checked={f.reminders} disabled={noOptionalChannel} onChange={(v) => set('reminders', v)} />
          <Switch label="Feedback requests" description="A quick survey after a visit." checked={f.surveys} disabled={noOptionalChannel} onChange={(v) => set('surveys', v)} />
          <Switch label="Offers & maintenance tips" checked={f.marketing} disabled={noOptionalChannel} onChange={(v) => set('marketing', v)} />
        </Section>

        <Section title="How often">
          <fieldset className="py-3" disabled={f.unsubscribeAll}>
            <legend className="sr-only">Message frequency</legend>
            <div className="space-y-2" role="radiogroup" aria-label="Message frequency">
              {FREQUENCIES.map((q) => (
                <label
                  key={q.key}
                  className={`flex min-h-[48px] cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                    f.frequency === q.key ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="frequency"
                    className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]"
                    checked={f.frequency === q.key}
                    onChange={() => set('frequency', q.key as PreferenceFrequency)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">{q.label}</span>
                    <span className="block text-xs text-text-secondary">{q.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </Section>

        <Section title="Language">
          <div className="py-3">
            <label htmlFor="pref-language" className="sr-only">
              Preferred language for messages
            </label>
            <select
              id="pref-language"
              value={f.language}
              onChange={(e) => set('language', e.target.value as PreferenceLanguage)}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                  {l.native !== l.english ? ` — ${l.english}` : ''}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-text-secondary">We'll use this language for messages whenever we can.</p>
          </div>
        </Section>

        <section className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">Unsubscribe from everything optional</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Stops reminders, feedback requests and offers on every channel. You'll still get essential messages like appointment confirmations, invoices and safety notices.
              </p>
              {!confirmAll ? (
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => setConfirmAll(true)} disabled={f.unsubscribeAll || saving}>
                  Unsubscribe from all
                </Button>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2" role="alertdialog" aria-label="Confirm unsubscribe">
                  <Button size="sm" disabled={saving} onClick={() => void submit(applyUnsubscribeAll(f))}>
                    {saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />} Yes, unsubscribe me
                  </Button>
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => setConfirmAll(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Sticky save bar: always reachable on small screens */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-secondary/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-3">
          <p className="min-w-0 flex-1 text-xs text-text-secondary" role="status" aria-live="polite">
            {justSaved && !dirty ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-success-500">
                <CheckCircle2 size={14} aria-hidden="true" /> Saved. Thank you!
              </span>
            ) : (
              summarize(f)
            )}
          </p>
          <Button size="md" disabled={!dirty || saving} onClick={() => void submit(f)}>
            {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}
