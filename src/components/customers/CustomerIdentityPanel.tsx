import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, Home, Loader2, Mail, MapPin, Phone, ShieldCheck, TriangleAlert, User, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  CONFIDENCE_LABELS,
  HOUSEHOLD_SOURCE_LABELS,
  KEY_TYPE_LABELS,
  buildHouseholdGraph,
  confidenceTone,
  describeSignals,
  displayKey,
  fetchIdentityProfile,
  groupKeys,
  setHouseholdMemberStatus,
  type GraphNode,
  type IdentityKeyType,
  type IdentityProfile,
} from '@/lib/identityResolution';

interface Props {
  customerId: string;
  customerName: string;
}

const KEY_ICONS: Record<IdentityKeyType, typeof Phone> = { phone: Phone, email: Mail, address: MapPin };

const NODE_STYLE: Record<GraphNode['kind'], { fill: string; stroke: string }> = {
  self: { fill: 'rgb(var(--accent-primary) / 0.18)', stroke: 'rgb(var(--accent-primary))' },
  member: { fill: 'rgba(148,163,184,0.14)', stroke: 'rgba(148,163,184,0.9)' },
  phone: { fill: 'rgba(34,197,94,0.12)', stroke: 'rgba(34,197,94,0.8)' },
  email: { fill: 'rgba(168,85,247,0.12)', stroke: 'rgba(168,85,247,0.8)' },
  address: { fill: 'rgba(245,158,11,0.12)', stroke: 'rgba(245,158,11,0.8)' },
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function CustomerIdentityPanel({ customerId, customerName }: Props) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<IdentityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const p = await fetchIdentityProfile(customerId);
      if (id !== requestRef.current) return;
      setProfile(p);
    } catch (e) {
      if (id !== requestRef.current) return;
      setError(errorText(e));
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const graph = useMemo(() => (profile ? buildHouseholdGraph(customerName, profile) : null), [profile, customerName]);
  const grouped = useMemo(() => groupKeys(profile?.keys ?? []), [profile]);

  const setStatus = async (customer: string, status: 'confirmed' | 'rejected') => {
    if (!profile?.household) return;
    setBusy(customer);
    try {
      await setHouseholdMemberStatus(profile.household.id, customer, status);
      toast(status === 'confirmed' ? 'Household member confirmed.' : 'Removed from this household.', 'success');
      await load();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const housemates = profile?.household?.members.filter((m) => !m.isSelf && m.status !== 'rejected') ?? [];
  const hasKeys = (profile?.keys.length ?? 0) > 0;

  return (
    <section
      aria-labelledby="identity-heading"
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Fingerprint className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id="identity-heading" className="text-base font-semibold text-text-primary">
            Identity &amp; household
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Every phone, email and address this customer has been seen with, and who lives with them.
          </p>
        </div>
      </div>

      {loading && !profile ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading identity…
        </div>
      ) : error ? (
        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm" role="alert">
          <span className="flex items-center gap-2 text-text-secondary">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : profile && graph ? (
        <div className="mt-5 space-y-6">
          {profile.candidates.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
              <p className="font-medium text-text-primary">
                {profile.candidates.length === 1 ? 'This customer may be a duplicate' : `${profile.candidates.length} possible duplicates`}
              </p>
              <ul className="mt-1 space-y-0.5 text-text-secondary">
                {profile.candidates.slice(0, 3).map((c) => (
                  <li key={c.id}>
                    {c.otherName} · {c.score}% · {describeSignals(c.signals)}
                  </li>
                ))}
              </ul>
              <Link to="/dashboard/duplicates" className="focus-ring mt-2 inline-block font-semibold text-accent hover:underline">
                Review in Duplicates
              </Link>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Known identifiers</h3>
              {!hasKeys ? (
                <p className="mt-2 text-sm text-text-secondary">No identifiers recorded yet.</p>
              ) : (
                <div className="mt-2 space-y-3">
                  {(Object.keys(grouped) as IdentityKeyType[]).map((type) =>
                    grouped[type].length === 0 ? null : (
                      <div key={type}>
                        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                          {grouped[type].length > 1 ? KEY_TYPE_LABELS[type].plural : KEY_TYPE_LABELS[type].singular}
                        </p>
                        <ul className="mt-1 space-y-1">
                          {grouped[type].map((k) => {
                            const Icon = KEY_ICONS[type];
                            return (
                              <li key={k.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm">
                                <Icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate text-text-primary">{displayKey(k)}</span>
                                {k.isPrimary && (
                                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">Primary</span>
                                )}
                                {k.seenCount > 1 && <span className="text-xs text-text-secondary">seen {k.seenCount}×</span>}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>

            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                <Home className="h-4 w-4" aria-hidden="true" />
                {profile.household ? profile.household.name : 'Household'}
              </h3>
              {housemates.length === 0 ? (
                <p className="mt-2 text-sm text-text-secondary">
                  No one else is linked to this customer. People who share an address or phone appear here automatically.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {housemates.map((m) => {
                    const tone = confidenceTone(m.confidence);
                    return (
                      <li key={m.customerId} className="rounded-lg border border-border bg-bg-primary p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link to={`/dashboard/customers/${m.customerId}`} className="focus-ring font-medium text-text-primary hover:underline">
                              {m.name}
                            </Link>
                            <p className="text-xs text-text-secondary">
                              {HOUSEHOLD_SOURCE_LABELS[m.source]} · {CONFIDENCE_LABELS[tone]}
                            </p>
                          </div>
                          {m.status === 'confirmed' ? (
                            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-500">
                              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Confirmed
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex gap-2">
                          {m.status !== 'confirmed' && (
                            <Button size="sm" variant="secondary" disabled={busy === m.customerId} onClick={() => void setStatus(m.customerId, 'confirmed')}>
                              Confirm
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === m.customerId}
                            onClick={() => void setStatus(m.customerId, 'rejected')}
                            aria-label={`Remove ${m.name} from this household`}
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" /> Not a match
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {(housemates.length > 0 || hasKeys) && (
            <figure>
              <svg
                viewBox={`0 0 ${graph.width} ${graph.height}`}
                className="h-auto w-full max-w-[520px] mx-auto"
                role="img"
                aria-label={`Identity graph for ${customerName}: ${housemates.length} household members and ${profile.keys.length} identifiers`}
              >
                {graph.edges.map((e) => {
                  const from = graph.nodes.find((n) => n.id === e.from);
                  const to = graph.nodes.find((n) => n.id === e.to);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={`${e.from}-${e.to}`}
                      x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                      stroke="rgba(148,163,184,0.7)"
                      strokeWidth={e.confidence >= 90 ? 2 : 1.25}
                      strokeDasharray={e.dashed ? '4 4' : undefined}
                    />
                  );
                })}
                {graph.nodes.map((n) => {
                  const style = NODE_STYLE[n.kind];
                  const w = n.kind === 'self' ? 132 : 120;
                  return (
                    <g key={n.id}>
                      <rect x={n.x - w / 2} y={n.y - 15} width={w} height={30} rx={15} fill={style.fill} stroke={style.stroke} strokeWidth={n.kind === 'self' ? 2 : 1} />
                      <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={11} fill="currentColor" className="fill-current text-text-primary">
                        {n.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <figcaption className="mt-1 flex items-center justify-center gap-1.5 text-xs text-text-secondary">
                <User className="h-3.5 w-3.5" aria-hidden="true" /> Solid line = confirmed or primary · dashed = suggested
              </figcaption>
            </figure>
          )}
        </div>
      ) : null}
    </section>
  );
}
