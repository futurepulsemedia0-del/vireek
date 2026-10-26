/**
 * Buyer data room — /data-room#<token>   (public, no login)
 *
 * The token lives in the URL FRAGMENT so it never reaches a server log or a Referer header. It is sent
 * once, in a POST body, to the exit-dataroom-public edge function, which checks expiry / revocation /
 * view limit and records the access. The page is noindex and shows a persistent estimate disclaimer.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { openDataRoom, type PublicDataRoom } from '@/lib/exitReadinessApi';
import { fmtMoney } from '@/lib/exitReadiness';
import { EmptyState } from '@/components/EmptyState';
import { Card } from '@/components/ui/Card';
import { SkeletonCardList } from '@/components/Skeleton';

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const money = (v: unknown): string => (typeof v === 'number' ? fmtMoney(v) : '—');

function Table({ caption, head, body }: { caption: string; head: string[]; body: ReactNode[][] }) {
  if (body.length === 0) return <p className="text-xs text-text-secondary">Nothing recorded for this section.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-text-secondary"><tr>{head.map((h) => <th key={h} scope="col" className="py-2 pr-4">{h}</th>)}</tr></thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-t border-border/60">{r.map((c, j) => <td key={j} className="py-2 pr-4 text-text-primary">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card className="!p-5"><h2 className="mb-3 text-lg font-semibold text-text-primary">{title}</h2>{children}</Card>;
}

function Content({ room }: { room: PublicDataRoom }) {
  const s = room.content.sections;
  const fin = obj(s.financials);
  const ttm = obj(fin.trailingTwelveMonths);
  const kpi = obj(s.kpis);
  const cred = obj(s.credentials);
  const val = obj(s.valuation);
  const range = obj(val.estimateRangeCents);
  return (
    <div className="space-y-5">
      {s.valuation !== undefined && (
        <Section title="Owner’s estimate summary">
          <p className="mb-2 text-xs font-semibold text-warning-500">{str(val.label)}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
            <div><p className="text-xs text-text-secondary">Method</p><p className="text-text-primary">{str(val.method)}</p></div>
            <div><p className="text-xs text-text-secondary">Range</p><p className="text-text-primary">{money(range.low)} – {money(range.high)}</p></div>
            <div><p className="text-xs text-text-secondary">Readiness score</p><p className="text-text-primary">{str(val.sellReadinessScore)} ({str(val.sellReadinessGrade)})</p></div>
            <div><p className="text-xs text-text-secondary">Data confidence</p><p className="text-text-primary">{str(val.confidence)}</p></div>
          </div>
          <h3 className="mb-1 mt-4 text-sm font-semibold text-text-primary">Documented adjustments</h3>
          <Table caption="Documented add-backs" head={['Type', 'Item', 'Annual amount', 'Justification']}
            body={rows(val.documentedAddBacks).map((a) => [str(a.type), str(a.label), money(a.amountCents), str(a.justification)])} />
        </Section>
      )}
      {s.financials !== undefined && (
        <Section title="Financial summary (trailing 12 months)">
          <div className="mb-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-text-secondary">Revenue</p><p className="font-semibold text-text-primary">{money(ttm.revenueCents)}</p></div>
            <div><p className="text-xs text-text-secondary">Expenses</p><p className="font-semibold text-text-primary">{money(ttm.expensesCents)}</p></div>
            <div><p className="text-xs text-text-secondary">Interest / taxes / D&A in ledger</p><p className="font-semibold text-text-primary">{money(Number(ttm.interestCents ?? 0) + Number(ttm.taxCents ?? 0) + Number(ttm.daCents ?? 0))}</p></div>
            <div><p className="text-xs text-text-secondary">Months of ledger data</p><p className="font-semibold text-text-primary">{str(obj(kpi.current).ledgerMonths)}</p></div>
          </div>
          <Table caption="Monthly revenue and expenses" head={['Month', 'Revenue', 'Expenses']} body={rows(ttm.monthly).map((m) => [str(m.month), money(m.revenueCents), money(m.expensesCents)])} />
          <h3 className="mb-1 mt-4 text-sm font-semibold text-text-primary">Balance sheet (as of today)</h3>
          <Table caption="Balance sheet" head={['Account', 'Type', 'Balance']} body={rows(fin.balanceSheet).map((b) => [`${str(b.accountCode)} ${str(b.accountName)}`, str(b.type), money(b.balanceCents)])} />
          <h3 className="mb-1 mt-4 text-sm font-semibold text-text-primary">Receivables aging</h3>
          <Table caption="Receivables aging" head={['Bucket (days overdue)', 'Open balance', 'Invoices']} body={rows(fin.receivablesAging).map((a) => [str(a.bucket), money(a.balanceCents), str(a.invoices)])} />
        </Section>
      )}
      {s.kpis !== undefined && (
        <Section title="KPI history">
          <Table caption="Monthly sell-readiness and estimate history" head={['Month', 'Readiness score', 'Estimate (low)', 'Estimate', 'Estimate (high)']}
            body={rows(kpi.history).map((h) => [str(h.month), str(h.readinessScore), money(h.valueLowCents), money(h.valuePointCents), money(h.valueHighCents)])} />
        </Section>
      )}
      {s.contracts !== undefined && (
        <Section title="Contracts">
          <Table caption="Contracts" head={['Contract', 'Type', 'Status', 'Ends', 'Auto-renew', 'Value']}
            body={rows(s.contracts).map((c) => [str(c.name), str(c.type), str(c.status), str(c.endDate), c.autoRenew ? 'Yes' : 'No', money(c.valueCents)])} />
        </Section>
      )}
      {s.equipment !== undefined && (
        <Section title="Equipment (installed base)">
          <Table caption="Installed equipment by type" head={['Type', 'Units', 'Avg age (yrs)', 'Under warranty']}
            body={rows(s.equipment).map((e) => [str(e.equipmentType), str(e.units), str(e.avgAgeYears), str(e.underWarranty)])} />
        </Section>
      )}
      {s.credentials !== undefined && (
        <Section title="Licences, insurance & credentials">
          <Table caption="Licences and credentials" head={['Holder', 'Credential', 'Authority', 'Expires', 'Status']}
            body={rows(cred.licences).map((c) => [str(c.holder), str(c.name ?? c.type), str(c.authority), str(c.expiresAt), str(c.status)])} />
          <h3 className="mb-1 mt-4 text-sm font-semibold text-text-primary">Insurance</h3>
          <Table caption="Insurance policies" head={['Holder', 'Policy', 'Carrier', 'Coverage', 'Expires']}
            body={rows(cred.insurance).map((p) => [str(p.holder), str(p.policyType), str(p.carrier), money(p.coverageCents), str(p.expiresAt)])} />
        </Section>
      )}
    </div>
  );
}

export function ExitDataRoomPublicPage() {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'rate_limited' | 'error'>('loading');
  const [room, setRoom] = useState<PublicDataRoom | null>(null);
  const started = useRef(false);

  useEffect(() => {
    document.title = 'Data room';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => { robots.remove(); referrer.remove(); };
  }, []);

  useEffect(() => {
    if (started.current) return; // StrictMode would otherwise count two views
    started.current = true;
    const token = window.location.hash.replace(/^#/, '').trim();
    if (!token) { setState('unavailable'); return; }
    void openDataRoom(token).then((r) => {
      if (r.ok) {
        // Remove the token from the address bar once it has been used successfully.
        window.history.replaceState(null, '', window.location.pathname);
        setRoom(r.room);
        setState('ready');
      } else setState(r.reason === 'unavailable' ? 'unavailable' : r.reason);
    });
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><Lock size={20} aria-hidden="true" /></span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{room?.label ?? 'Confidential data room'}</h1>
          {room && <p className="text-xs text-text-secondary">Prepared {new Date(room.content.generatedAt).toLocaleDateString()} · link expires {new Date(room.expiresAt).toLocaleString()} · {room.viewsRemaining} views left</p>}
        </div>
      </div>

      {state === 'loading' && <SkeletonCardList count={3} />}
      {state === 'unavailable' && <EmptyState icon={Lock} title="This link is no longer available" description="It may have expired, been revoked or reached its view limit. Ask the sender for a new link." />}
      {state === 'rate_limited' && <EmptyState icon={Lock} title="Too many attempts" description="Please wait a few minutes and try again." />}
      {state === 'error' && <EmptyState icon={Lock} title="Couldn’t open the data room" description="Check your connection and reload this page." action={{ label: 'Reload', onClick: () => window.location.reload() }} />}
      {state === 'ready' && room && (
        <>
          <div role="note" className="mb-5 rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2.5 text-xs text-text-secondary">
            <span className="font-semibold text-text-primary">Confidential. </span>{room.content.disclaimer}
          </div>
          <Content room={room} />
        </>
      )}
    </main>
  );
}
