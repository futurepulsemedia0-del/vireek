/**
 * Public view of a versioned Home Passport share link — /passport/share/:token (no login).
 * Reads only the sealed v2 snapshot through verify_home_passport_share().
 * Defence in depth: refuses to render a payload that contains a forbidden (PII/price) key.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Printer, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  VERIFICATION_LABELS,
  findForbiddenKeys,
  formatRange,
  formatWindow,
  isRenderableRange,
  verifyShare,
  type PayloadV2,
  type PublicShareResult,
  type VerificationLevel,
} from '@/lib/homePassportPilot';

const PROBLEM_COPY: Record<string, { title: string; body: string }> = {
  expired: { title: 'This passport link has expired', body: 'Ask the sender for a new link.' },
  revoked: { title: 'This passport link was revoked', body: 'The sender withdrew access. Do not rely on any copy you may have seen earlier.' },
  exhausted: { title: 'This link has reached its view limit', body: 'Ask the sender for a new link.' },
  tampered: { title: 'Integrity check failed', body: 'This record does not match its seal. Do not trust it.' },
  not_found: { title: 'Passport not found', body: 'The link is incorrect or was never issued by Vireek.' },
  rate_limited: { title: 'Too many requests', body: 'Please wait a few minutes and try again.' },
};

function Badge({ level }: { level?: VerificationLevel }) {
  if (!level) return null;
  const tone = level === 'contractor_verified' ? 'text-success-500 border-success-500/40' : level === 'owner_added' ? 'text-warning-500 border-warning-500/40' : 'text-text-secondary border-border';
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{VERIFICATION_LABELS[level]}</span>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <Card className="p-5">
        <h2 id={id} className="text-base font-semibold text-text-primary">{title}</h2>
        <div className="mt-3">{children}</div>
      </Card>
    </section>
  );
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function PassportV2({ data }: { data: PayloadV2 }) {
  const place = [data.property.address, data.property.city, [data.property.state, data.property.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const ranges = isRenderableRange(data.cost_ranges) ? data.cost_ranges : null;
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Home Service Passport</p>
        <h1 className="mt-1 break-words text-2xl font-bold text-text-primary">{place || 'Property'}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {data.serviced_by ? `Serviced by ${data.serviced_by} · ` : ''}Snapshot generated {new Date(data.generated_at).toLocaleDateString('en-US')}
        </p>
        <ul className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Verification levels">
          {(Object.keys(data.verification_levels) as VerificationLevel[]).map((k) => (
            <li key={k} className="flex items-center gap-1.5"><Badge level={k} /><span className="text-text-secondary">{data.verification_levels[k]}</span></li>
          ))}
        </ul>
      </Card>

      <Section id="pp-equipment" title="Equipment">
        {data.equipment.length === 0 ? <p className="text-sm text-text-secondary">No equipment on record.</p> : (
          <ul className="divide-y divide-border text-sm">
            {data.equipment.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-text-primary">{str(e.label) || str(e.equipment_type)}
                  <span className="ml-2 text-text-secondary">{[str(e.install_date) && `installed ${str(e.install_date)}`, str(e.warranty_status) && `warranty ${str(e.warranty_status)}`].filter(Boolean).join(' · ')}</span>
                </span>
                <Badge level={e.verification} />
              </li>
            ))}
          </ul>
        )}
        {data.owner_added_items.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold text-text-primary">Added by the homeowner</h3>
            <ul className="mt-1 divide-y divide-border text-sm">
              {data.owner_added_items.map((o, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-text-primary">{[o.name, o.brand, o.model].filter(Boolean).join(' · ')}</span>
                  <Badge level={o.verification} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="pp-history" title="Service history">
        {data.service_history.length === 0 ? <p className="text-sm text-text-secondary">No completed service visits on record.</p> : (
          <ul className="divide-y divide-border text-sm">
            {data.service_history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-text-primary">{str(h.date)} · {str(h.service_type) || 'Service visit'}</span>
                <Badge level={h.verification} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="pp-permits" title="Permits">
        {data.permits.length === 0 ? <p className="text-sm text-text-secondary">No permits on file.</p> : (
          <ul className="divide-y divide-border text-sm">
            {data.permits.map((p, i) => (
              <li key={i} className="py-2 text-text-primary">{str(p.permit_type)} {str(p.permit_number) && `#${str(p.permit_number)}`} · {str(p.status)}{str(p.jurisdiction) && ` · ${str(p.jurisdiction)}`}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="pp-issues" title="Known issues">
        {data.known_problems.length === 0 ? <p className="text-sm text-text-secondary">No known issues recorded.</p> : (
          <ul className="space-y-2 text-sm">
            {data.known_problems.map((p, i) => (
              <li key={i}><span className="font-medium text-text-primary">{p.title}</span>{p.detail && <span className="block text-text-secondary">{p.detail}</span>}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="pp-predictions" title="Predicted maintenance and costs (estimates)">
        {data.maintenance_windows.length === 0 && !ranges ? <p className="text-sm text-text-secondary">No estimates available for this property.</p> : null}
        {data.maintenance_windows.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {data.maintenance_windows.map((m, i) => (
              <li key={i} className="py-2 text-text-primary">
                {m.equipment}
                {formatWindow(m.service_window_from, m.service_window_to) && <span className="ml-2 text-text-secondary">service likely {formatWindow(m.service_window_from, m.service_window_to)}</span>}
                {m.overdue && <span className="ml-2 text-warning-500">overdue</span>}
              </li>
            ))}
          </ul>
        )}
        {ranges && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-3"><p className="text-xs text-text-secondary">Next 12 months (range)</p><p className="text-lg font-semibold text-text-primary">{formatRange(ranges.annual_range.low, ranges.annual_range.high)}</p></div>
            <div className="rounded-xl border border-border p-3"><p className="text-xs text-text-secondary">Next 5 years (range)</p><p className="text-lg font-semibold text-text-primary">{formatRange(ranges.five_year_range.low, ranges.five_year_range.high)}</p></div>
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-text-primary">Assumptions ({ranges.confidence} confidence)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">{ranges.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              <p className="mt-2 text-xs text-text-secondary">{ranges.disclaimer}</p>
            </div>
          </div>
        )}
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">{data.prediction_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </Section>
    </div>
  );
}

export function PublicHomePassportSharePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [result, setResult] = useState<PublicShareResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    verifyShare(token)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const valid = result?.status === 'valid' ? result : null;
  const unsafe = valid ? findForbiddenKeys(valid.snapshot).length > 0 : false;
  const problem = result && result.status !== 'valid' ? PROBLEM_COPY[result.status] : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          {loading && <div className="h-64 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" aria-label="Loading passport" />}

          {!loading && (failed || problem || unsafe) && (
            <Card className="text-center" role="alert">
              <AlertCircle className="mx-auto text-danger" size={32} aria-hidden="true" />
              <h1 className="mt-3 text-lg font-semibold text-text-primary">
                {failed ? 'Could not verify this passport' : unsafe ? 'This passport cannot be displayed' : (problem?.title ?? 'Passport unavailable')}
              </h1>
              <p className="mt-1.5 text-sm text-text-secondary">
                {failed ? 'Please check your connection and try again.' : unsafe ? 'It failed a privacy check.' : (problem?.body ?? 'Please try again later.')}
              </p>
            </Card>
          )}

          {valid && !unsafe && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success-500">
                  <ShieldCheck size={14} aria-hidden="true" /> Verified by Vireek · version {valid.version}
                </p>
                <Button variant="secondary" size="sm" onClick={() => window.print()}>
                  <Printer size={15} aria-hidden="true" /> Print / save as PDF
                </Button>
              </div>
              <PassportV2 data={valid.snapshot} />
              <div className="rounded-2xl border border-success-500/30 bg-success-500/5 p-5 text-xs text-text-secondary">
                <p className="font-medium text-success-500">Integrity verified</p>
                <p className="mt-1">
                  Issued {new Date(valid.issued_at).toLocaleDateString('en-US')} with the property owner’s consent · link valid until {new Date(valid.expires_at).toLocaleDateString('en-US')}.
                  This passport is not a home inspection, appraisal or warranty.
                </p>
                <p className="mt-1.5 break-all font-mono text-[10px]">SHA-256 {valid.snapshot_hash}</p>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
