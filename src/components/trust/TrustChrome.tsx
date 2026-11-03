import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/trust/ClaimBadge';
import { getClaim } from '@/lib/trust/claims';

export const TRUST_NAV = [
  { id: 'trust', label: 'Trust Center', href: '/trust' },
  { id: 'compliance', label: 'Compliance', href: '/trust/compliance' },
  { id: 'security', label: 'Security', href: '/security' },
  { id: 'whitepaper', label: 'Whitepaper', href: '/security/whitepaper' },
  { id: 'subprocessors', label: 'Sub-processors', href: '/subprocessors' },
  { id: 'sla', label: 'SLA', href: '/sla' },
  { id: 'status', label: 'Status', href: '/status' },
  { id: 'changelog', label: 'Changelog', href: '/changelog' },
  { id: 'customers', label: 'Customers', href: '/customers' },
] as const;

export type TrustNavId = (typeof TRUST_NAV)[number]['id'];

/** Shared sub-navigation so every trust page looks and behaves the same. */
export function TrustSubNav({ current }: { current: TrustNavId }) {
  return (
    <nav aria-label="Trust Center" className="border-b border-border bg-bg-secondary/60 px-5 sm:px-6">
      <ul className="mx-auto flex max-w-5xl gap-2 overflow-x-auto py-3">
        {TRUST_NAV.map((n) => {
          const active = n.id === current;
          return (
            <li key={n.id} className="shrink-0">
              <Link
                to={n.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function fmt(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Status badges (from the claims registry) + last-reviewed date + owner, in one consistent bar. */
export function TrustMetaBar({ claimIds = [], reviewedOn, owner }: { claimIds?: string[]; reviewedOn: string; owner?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-secondary">
      {claimIds.map((id) => (
        <span key={id} className="inline-flex items-center gap-2">
          <StatusBadge status={getClaim(id).status} />
          <span className="sr-only">{getClaim(id).statement}</span>
        </span>
      ))}
      <span>Last reviewed {fmt(reviewedOn)}</span>
      {owner ? <span>Owner: {owner}</span> : null}
    </div>
  );
}
