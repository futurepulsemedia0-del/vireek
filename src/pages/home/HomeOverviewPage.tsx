import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ChevronRight, HeartPulse, Receipt } from 'lucide-react';
import { useHomeowner } from '@/contexts/HomeownerAuthContext';
import { formatDateTime, formatMoney } from '@/lib/homeowner/format';
import { Badge, Card, SecondaryButton } from './ui';

export function HomeOverviewPage() {
  const { overview, refresh } = useHomeowner();
  const businesses = overview?.businesses ?? [];
  const live = businesses.filter((b) => b.live);
  const pending = businesses.filter((b) => b.status === 'pending');

  const nextUp = useMemo(
    () =>
      live
        .flatMap((b) =>
          b.next_appointment?.scheduled_datetime ? [{ ...b.next_appointment, business: b.business_name, linkId: b.link_id }] : [],
        )
        .sort((a, b) => new Date(a.scheduled_datetime ?? 0).getTime() - new Date(b.scheduled_datetime ?? 0).getTime())[0],
    [live],
  );
  const outstanding = live.reduce((sum, b) => sum + (b.outstanding_cents ?? 0), 0);
  const hasInvoiceScope = live.some((b) => b.scopes.invoices);
  const name = overview?.profile?.full_name?.split(' ')[0];

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{name ? `Hi, ${name}` : 'Welcome home'}</h1>
          <p className="text-sm text-text-secondary">Everything your home services are doing, in one place.</p>
        </div>
        <SecondaryButton onClick={() => void refresh()} className="min-h-[36px] px-3 py-1.5 text-xs">Refresh</SecondaryButton>
      </header>

      {pending.length > 0 && (
        <Link
          to="/home/businesses"
          className="focus-ring flex items-center justify-between rounded-2xl border border-accent/30 bg-accent/10 p-4 text-sm"
        >
          <span className="font-medium text-text-primary">
            {pending.length === 1 ? '1 provider wants to connect' : `${pending.length} providers want to connect`}
            <span className="block text-xs font-normal text-text-secondary">Nothing is shared until you choose.</span>
          </span>
          <ChevronRight size={18} aria-hidden />
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CalendarClock size={18} className="text-accent" aria-hidden />
          <p className="mt-2 text-xs text-text-secondary">Next appointment</p>
          {nextUp ? (
            <Link to={`/home/b/${nextUp.linkId}`} className="focus-ring">
              <p className="text-sm font-semibold text-text-primary">{formatDateTime(nextUp.scheduled_datetime)}</p>
              <p className="truncate text-xs text-text-secondary">{nextUp.service_type ?? 'Service visit'} · {nextUp.business}</p>
            </Link>
          ) : (
            <p className="text-sm text-text-secondary">None scheduled</p>
          )}
        </Card>
        <Card>
          <Receipt size={18} className="text-accent" aria-hidden />
          <p className="mt-2 text-xs text-text-secondary">Amount due</p>
          <p className="text-lg font-semibold text-text-primary">{hasInvoiceScope ? formatMoney(outstanding) : '—'}</p>
          {!hasInvoiceScope && <p className="text-xs text-text-secondary">Share invoices to see this</p>}
        </Card>
      </div>

      <h2 className="pt-2 text-sm font-semibold text-text-primary">Your providers</h2>
      {live.length === 0 ? (
        <Card>
          <p className="text-sm text-text-secondary">
            No providers connected yet. If a business already has your number, it will show up under Providers after you
            approve it — or paste a portal link they sent you.
          </p>
          <Link to="/home/businesses" className="focus-ring mt-3 inline-block text-sm font-semibold text-accent">
            Go to Providers
          </Link>
        </Card>
      ) : (
        <ul className="space-y-3">
          {live.map((b) => (
            <li key={b.link_id}>
              <Link to={`/home/b/${b.link_id}`} className="focus-ring block rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-semibold text-text-primary">{b.business_name}</p>
                  <ChevronRight size={18} className="shrink-0 text-text-secondary" aria-hidden />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {b.next_appointment?.scheduled_datetime && <Badge tone="accent">Next: {formatDateTime(b.next_appointment.scheduled_datetime)}</Badge>}
                  {b.scopes.invoices && (b.outstanding_cents ?? 0) > 0 && <Badge tone="warn">{formatMoney(b.outstanding_cents)} due</Badge>}
                  {b.scopes.health && b.health_score != null && (
                    <Badge tone={b.health_score >= 75 ? 'good' : b.health_score >= 50 ? 'warn' : 'bad'}>
                      <HeartPulse size={12} className="mr-1 inline" aria-hidden />Home health {b.health_score}
                    </Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
