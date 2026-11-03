import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/trust/ClaimBadge';
import { EVIDENCE_ITEMS, REQUEST_ACCESS_HREF, type EvidenceAvailability } from '@/lib/trust/evidence';

const ACTION: Record<EvidenceAvailability, string> = { public: 'Open', on_request: 'Request', not_available: '' };

/** Downloadable / requestable evidence, with honest availability for items that do not exist yet. */
export function EvidenceLibrary() {
  return (
    <section aria-labelledby="evidence-heading" className="px-5 py-12 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <h2 id="evidence-heading" className="text-2xl font-bold text-text-primary">Evidence library</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Everything we can show you today, and what we cannot yet. Need something else?{' '}
          <Link to={REQUEST_ACCESS_HREF} className="font-semibold text-accent hover:underline">Use the request form</Link>.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {EVIDENCE_ITEMS.map((e) => (
            <li key={e.id} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-text-primary">{e.title}</h3>
                <StatusBadge status={e.status} />
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{e.description}</p>
              {e.href ? (
                <Link to={e.href} className="mt-3 inline-block text-sm font-semibold text-accent hover:underline">
                  {ACTION[e.availability]} {e.title.toLowerCase()}
                </Link>
              ) : (
                <p className="mt-3 text-xs font-semibold text-text-secondary">Not available</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
