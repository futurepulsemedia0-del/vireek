/**
 * Public customer findings report — /findings/:token (no auth).
 * Reads and answers ONLY through the findings-package-public edge function
 * (matches on the unguessable token; photos are short-lived signed URLs; the
 * approved price is recomputed server-side).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock3, Loader2, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Skeleton } from '@/components/Skeleton';
import { AnnotatableImage } from '@/components/AnnotatableImage';
import { TIER_META } from '@/lib/estimates';
import {
  SEVERITY_LABEL,
  SEVERITY_STYLE,
  defaultOptionId,
  formatDate,
  formatMoney,
  isDecisionable,
  optionTotalCents,
  selectionTotals,
  type ApprovalResult,
  type PublicFinding,
  type PublicFindings,
  type PublicFindingsResult,
} from '@/lib/findingsPackage';
import { RespondError, fetchPublicFindings, respondToFindings } from '@/lib/findingsPackageApi';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10 sm:py-14">
        <div className="mx-auto w-full max-w-3xl space-y-6">{children}</div>
      </main>
      <Footer />
    </div>
  );
}

function Notice({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
      <div className="mx-auto mb-3 flex justify-center text-text-secondary">{icon}</div>
      <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
      <p className="mt-2 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

export function FindingsPackagePublicPage() {
  const { token } = useParams<{ token: string }>();
  const [result, setResult] = useState<PublicFindingsResult | null>(null);

  const load = useCallback(async () => {
    setResult(null);
    setResult(token ? await fetchPublicFindings(token) : { ok: false, reason: 'not_found' });
  }, [token]);
  useEffect(() => void load(), [load]);

  if (result === null) {
    return (
      <Shell>
        <div className="space-y-4" aria-busy="true" aria-label="Loading your report">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-64 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </Shell>
    );
  }
  if (!result.ok) {
    const copy = {
      not_found: ['Report not found', "This link doesn't match an active report."],
      expired: ['This link has expired', 'Please contact the company and ask for a fresh link.'],
      error: ["We couldn't load your report", 'Check your connection and try again.'],
    }[result.reason];
    return (
      <Shell>
        <Notice icon={<AlertCircle size={28} />} title={copy[0]} body={copy[1]} />
        {result.reason === 'error' && (
          <button type="button" onClick={() => void load()} className="focus-ring mx-auto block rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white">Try again</button>
        )}
      </Shell>
    );
  }
  return (
    <Shell>
      <Report data={result.data} token={token!} />
    </Shell>
  );
}

function Report({ data, token }: { data: PublicFindings; token: string }) {
  const { package: pkg, items, businessName } = data;
  const answered = pkg.status !== 'sent';
  const decisionable = useMemo(() => items.filter(isDecisionable), [items]);

  const [selection, setSelection] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(decisionable.map((i) => [i.id, defaultOptionId(i)])),
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ApprovalResult | null>(null);

  const totals = selectionTotals(decisionable, selection, pkg.tax_percent);
  const nameOk = name.trim().length >= 2;

  async function submit() {
    if (!nameOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const decisions = decisionable.map((i) => ({ item_id: i.id, option_id: selection[i.id] ?? null }));
      setDone(await respondToFindings(token, decisions, name.trim()));
    } catch (e) {
      setError(e instanceof RespondError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Notice
        icon={<CheckCircle2 size={32} className="text-success-500" />}
        title={done.approved_count > 0 ? 'Thank you — you’re all set' : 'Thanks for letting us know'}
        body={
          done.approved_count > 0
            ? `You approved ${done.approved_count} repair${done.approved_count === 1 ? '' : 's'} (${formatMoney(done.approved_total_cents)}). ${businessName ?? 'We'} will contact you to schedule the work.`
            : 'You declined the recommended repairs. If you change your mind, just get in touch.'
        }
      />
    );
  }

  return (
    <>
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{businessName ?? 'Inspection findings'}</p>
        <h1 className="mt-1 text-2xl font-bold text-text-primary sm:text-3xl">{pkg.title}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Prepared for {pkg.customer_name}{pkg.address ? ` · ${pkg.address}` : ''}{pkg.technician_name ? ` · by ${pkg.technician_name}` : ''}
        </p>
        {pkg.summary && <p className="mt-4 whitespace-pre-line rounded-xl bg-bg-secondary p-4 text-sm text-text-primary">{pkg.summary}</p>}
      </header>

      {answered && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4 text-sm">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-success-500" />
          <p className="text-text-primary">
            {pkg.status === 'declined' ? 'You declined all recommended repairs' : `You approved ${formatMoney(pkg.approved_total_cents)} of repairs`} on {formatDate(pkg.responded_at)}.
          </p>
        </div>
      )}

      <ol className="space-y-5">
        {items.map((item, i) => (
          <FindingCard
            key={item.id}
            item={item}
            index={i}
            taxPercent={pkg.tax_percent}
            answered={answered}
            selected={selection[item.id] ?? null}
            onSelect={(optionId) => setSelection((prev) => ({ ...prev, [item.id]: optionId }))}
          />
        ))}
      </ol>

      {!answered && (
        <section className="sticky bottom-3 rounded-2xl border border-border bg-bg-secondary/95 p-4 shadow-xl backdrop-blur" aria-label="Approve repairs">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs text-text-secondary">{totals.count} repair{totals.count === 1 ? '' : 's'} selected{pkg.tax_percent > 0 ? ' · tax included' : ''}</p>
              <p className="text-2xl font-bold text-text-primary" aria-live="polite">{formatMoney(totals.totalCents)}</p>
            </div>
            <p className="flex items-center gap-1 text-xs text-text-secondary"><Clock3 size={12} /> Valid until {formatDate(pkg.share_expires_at)}</p>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" aria-label="Your full name" placeholder="Type your full name to authorize" className="focus-ring flex-1 rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary" />
            <button type="button" onClick={submit} disabled={!nameOk || busy} className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />}
              {totals.count > 0 ? `Approve ${totals.count} repair${totals.count === 1 ? '' : 's'}` : 'Decline all repairs'}
            </button>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
          <p className="mt-2 text-[11px] text-text-secondary">Approving authorizes {businessName ?? 'the company'} to schedule the selected work at the prices shown. Anything you skip is declined.</p>
        </section>
      )}
    </>
  );
}

function FindingCard({
  item,
  index,
  taxPercent,
  answered,
  selected,
  onSelect,
}: {
  item: PublicFinding;
  index: number;
  taxPercent: number;
  answered: boolean;
  selected: string | null;
  onSelect: (optionId: string | null) => void;
}) {
  const priced = isDecisionable(item);
  const skipped = priced && !answered && selected === null;

  return (
    <li className={`overflow-hidden rounded-2xl border bg-bg-secondary ${skipped ? 'border-border opacity-75' : 'border-border'}`}>
      {item.photo_url && (
        <AnnotatableImage imageUrl={item.photo_url} existingAnnotations={item.annotations} editable={false} />
      )}
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-secondary">Finding {index + 1}</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[item.severity]}`}>{SEVERITY_LABEL[item.severity]}</span>
          {answered && item.decision !== 'pending' && priced && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.decision === 'approved' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
              {item.decision === 'approved' ? `Approved · ${formatMoney(item.approved_cents ?? 0)}` : 'Declined'}
            </span>
          )}
        </div>
        <h2 className="text-lg font-semibold text-text-primary">{item.title}</h2>
        {item.description && <p className="whitespace-pre-line text-sm text-text-secondary">{item.description}</p>}

        {priced && !answered && (
          <fieldset className="space-y-2">
            <legend className="sr-only">Choose an option for {item.title}</legend>
            {item.options.map((option) => {
              const on = selected === option.id;
              const recommended = option.id === item.recommended_option_id || option.recommended;
              return (
                <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${on ? 'border-accent bg-accent/5' : `${TIER_META[option.tier].ringClass} hover:border-accent/50`}`}>
                  <input type="radio" name={`opt-${item.id}`} checked={on} onChange={() => onSelect(option.id)} className="mt-1 h-4 w-4 accent-[var(--color-accent,#2563eb)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{option.name}</span>
                      {recommended && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Recommended</span>}
                    </span>
                    {option.summary && <span className="mt-0.5 block text-xs text-text-secondary">{option.summary}</span>}
                    <span className="mt-1 block text-xs text-text-secondary">{option.line_items.map((li) => li.description).filter(Boolean).join(' · ')}</span>
                    {option.warranty_label && <span className="mt-0.5 block text-xs text-success-500">{option.warranty_label}</span>}
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-text-primary">{formatMoney(optionTotalCents(option, taxPercent))}</span>
                </label>
              );
            })}
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm text-text-secondary hover:border-accent/50">
              <input type="radio" name={`opt-${item.id}`} checked={selected === null} onChange={() => onSelect(null)} className="h-4 w-4" />
              Skip this repair for now
            </label>
          </fieldset>
        )}
      </div>
    </li>
  );
}
