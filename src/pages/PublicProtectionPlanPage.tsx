/**
 * Customer-facing protection plan certificate — /protection/:token
 * Public, token-gated (no sign-in). Shows what is covered, the limits, the unit(s), the term and the
 * full terms. Never exposes internal ids, payments or the claims ledger.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { fetchCertificate, formatMoney, termLabel, type PublicCertificate } from '@/lib/protectionPlans';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; cert: PublicCertificate };

const fmt = (v: string | null) => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

const STATUS_TEXT: Record<PublicCertificate['status'], { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-success-500/10 text-success-500' },
  expired: { label: 'Expired', cls: 'bg-bg-tertiary text-text-secondary' },
  pending_payment: { label: 'Awaiting payment', cls: 'bg-warning-500/10 text-warning-500' },
  cancelled: { label: 'Cancelled', cls: 'bg-danger/10 text-danger' },
};

export function PublicProtectionPlanPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    fetchCertificate(token).then((cert) => {
      if (live) setState(cert ? { kind: 'ready', cert } : { kind: 'missing' });
    });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl">
        {state.kind === 'loading' && <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading your protection plan" />}

        {state.kind === 'missing' && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
            <ShieldCheck size={32} className="mx-auto text-text-secondary" />
            <h1 className="mt-3 text-lg font-semibold text-text-primary">We couldn’t find this plan</h1>
            <p className="mt-1 text-sm text-text-secondary">The link may be incorrect or the plan was cancelled. Please contact the business that sold it to you.</p>
          </div>
        )}

        {state.kind === 'ready' && <Certificate cert={state.cert} />}
      </div>
    </main>
  );
}

function Certificate({ cert }: { cert: PublicCertificate }) {
  const status = STATUS_TEXT[cert.status];
  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      <header className="border-b border-border p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{cert.business_name ?? 'Service protection plan'}</p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{cert.plan_name}</h1>
            <p className="mt-0.5 text-sm text-text-secondary">
              Plan {cert.contract_number} · {termLabel(cert.term_months)}
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.cls}`}>{status.label}</span>
        </div>
        <p className="mt-3 text-sm text-text-primary">
          Prepared for <strong>{cert.customer_name}</strong>
        </p>
      </header>

      <section className="grid gap-4 border-b border-border p-6 sm:grid-cols-2">
        <Row label="Coverage starts" value={fmt(cert.coverage_start)} />
        <Row label="Coverage ends" value={fmt(cert.coverage_end)} />
        <Row label="Deductible per claim" value={formatMoney(cert.deductible_cents)} />
        <Row label="Waiting period" value={cert.waiting_period_days === 0 ? 'None' : `${cert.waiting_period_days} days`} />
        <Row label="Maximum per claim" value={cert.per_claim_limit_cents === null ? 'No per-claim limit' : formatMoney(cert.per_claim_limit_cents)} />
        <Row label="Maximum total coverage" value={cert.aggregate_limit_cents === null ? 'No total limit' : formatMoney(cert.aggregate_limit_cents)} />
        <Row label="Money-back period" value={cert.free_look_days === 0 ? 'None' : `${cert.free_look_days} days (if no claims)`} />
        <Row label="Plan price" value={formatMoney(cert.price_cents)} />
      </section>

      <section className="border-b border-border p-6">
        <h2 className="text-sm font-semibold text-text-primary">Covered equipment</h2>
        {cert.equipment.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">No equipment has been added to this plan yet. Contact us to add it.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {cert.equipment.map((u, i) => (
              <li key={i} className="rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
                {u.equipment_type}
                {[u.make, u.model].filter(Boolean).length > 0 && ` · ${[u.make, u.model].filter(Boolean).join(' ')}`}
                {u.serial_last4 && <span className="text-text-secondary"> · serial ending {u.serial_last4}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(cert.covered_items.length > 0 || cert.exclusions.length > 0) && (
        <section className="grid gap-6 border-b border-border p-6 sm:grid-cols-2">
          {cert.covered_items.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-primary">What’s covered</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {cert.covered_items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          )}
          {cert.exclusions.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-primary">What’s not covered</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {cert.exclusions.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="p-6">
        <h2 className="text-sm font-semibold text-text-primary">How to make a claim</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Contact {cert.business_name ?? 'the business that sold you this plan'} as soon as something stops working and mention plan {cert.contract_number}. Claims for a failure during the plan term can be
          reported up to 30 days after it ends.
        </p>
        {cert.terms && (
          <>
            <h2 className="mt-5 text-sm font-semibold text-text-primary">Full terms &amp; conditions</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{cert.terms}</p>
          </>
        )}
      </section>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-text-primary">{value}</p>
    </div>
  );
}
