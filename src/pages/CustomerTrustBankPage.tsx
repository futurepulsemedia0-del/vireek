import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, TriangleAlert as AlertTriangle, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  MANUAL_EVENT_META, EVENT_LABELS, trustTier, fetchCustomersByTrust, fetchTrustEvents,
  logTrustEvent, fetchTrustErosionAlerts,
  type CustomerTrustSummary, type TrustEvent, type TrustErosionAlert, type ManualTrustEventType,
} from '@/lib/customerTrustBank';

export function CustomerTrustBankPage() {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<CustomerTrustSummary[]>([]);
  const [alerts, setAlerts] = useState<TrustErosionAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [events, setEvents] = useState<TrustEvent[]>([]);
  const [logging, setLogging] = useState<string | null>(null);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    try { setCustomers(await fetchCustomersByTrust(100)); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not load customers.', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    try { setAlerts(await fetchTrustErosionAlerts()); }
    catch { /* alerts are a bonus — don't block the page on this */ }
    finally { setLoadingAlerts(false); }
  }, []);

  useEffect(() => { loadCustomers(); loadAlerts(); }, [loadCustomers, loadAlerts]);

  const toggleExpand = async (customerId: string) => {
    if (expandedId === customerId) { setExpandedId(null); return; }
    setExpandedId(customerId);
    try { setEvents(await fetchTrustEvents(customerId)); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not load history.', 'error'); }
  };

  const log = async (customerId: string, eventType: ManualTrustEventType) => {
    setLogging(`${customerId}:${eventType}`);
    try {
      await logTrustEvent(customerId, eventType);
      toast(`Logged: ${MANUAL_EVENT_META[eventType].label}`, 'success');
      await loadCustomers();
      if (expandedId === customerId) setEvents(await fetchTrustEvents(customerId));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not log this event.', 'error');
    } finally {
      setLogging(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Customer Trust Bank">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><ShieldCheck size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Customer Trust Bank</h1>
          <p className="text-sm text-text-secondary">A running trust balance per customer — catches erosion before it becomes churn or a bad review.</p>
        </div>
      </div>

      {!loadingAlerts && alerts.length > 0 && (
        <div className="mb-6 space-y-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-danger-500"><AlertTriangle size={14} /> Trust eroding — act soon</h2>
          {alerts.map((a) => (
            <div key={a.customer_id} className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{a.headline}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">Trust {Math.round(a.trust_score)} · {a.recent_30d_delta} pts in 30 days · {a.event_count_30d} event(s)</p>
                  <p className="mt-1.5 text-xs font-medium text-accent">→ {a.intervention}</p>
                </div>
                <Link to={`/dashboard/customers/${a.customer_id}`} className="focus-ring shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
                  View customer
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-text-primary">All customers, lowest trust first</h2>
      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : customers.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">No customers yet — trust balances build up as you log jobs and events.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {customers.map((c) => {
            const tier = trustTier(c.trust_score);
            const isOpen = expandedId === c.id;
            return (
              <div key={c.id} className="rounded-2xl border border-border bg-bg-secondary">
                <button type="button" onClick={() => toggleExpand(c.id)} className="focus-ring flex w-full items-center justify-between gap-3 p-4 text-left">
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ${tier.className}`}>{Math.round(c.trust_score)}</span>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{c.name}</p>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tier.className}`}>{tier.label}</span>
                    </div>
                  </div>
                  <ChevronDown size={16} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                {isOpen && (
                  <div className="border-t border-border p-4">
                    <p className="mb-2 text-xs font-semibold text-text-primary">Log an event</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(Object.keys(MANUAL_EVENT_META) as ManualTrustEventType[]).map((type) => (
                        <button
                          key={type}
                          type="button"
                          disabled={logging === `${c.id}:${type}`}
                          onClick={() => log(c.id, type)}
                          className={`focus-ring rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                            MANUAL_EVENT_META[type].delta > 0
                              ? 'border-success-500/30 text-success-500 hover:bg-success-500/10'
                              : 'border-danger-500/30 text-danger-500 hover:bg-danger-500/10'
                          }`}
                        >
                          {MANUAL_EVENT_META[type].label} ({MANUAL_EVENT_META[type].delta > 0 ? '+' : ''}{MANUAL_EVENT_META[type].delta})
                        </button>
                      ))}
                    </div>

                    <p className="mb-1.5 mt-4 text-xs font-semibold text-text-primary">Recent history</p>
                    {events.length === 0 ? (
                      <p className="text-xs text-text-secondary">No events logged yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {events.map((e) => (
                          <li key={e.id} className="flex items-center justify-between text-xs text-text-secondary">
                            <span>{EVENT_LABELS[e.event_type]}{e.source === 'auto' ? ' · auto' : ''}</span>
                            <span className={e.delta > 0 ? 'text-success-500' : 'text-danger-500'}>{e.delta > 0 ? '+' : ''}{e.delta} · {new Date(e.created_at).toLocaleDateString()}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
}
