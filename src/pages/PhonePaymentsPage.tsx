import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Lock, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import {
  auditToCsv, cardLabel, EVENT_LABELS, fetchAudit, fetchSessions, money, STATUS_LABELS, STATUS_STYLES, verifyChain,
  type PhonePaymentAuditEvent, type PhonePaymentSession,
} from '@/lib/phonePayments';

export function PhonePaymentsPage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [rows, setRows] = useState<PhonePaymentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<PhonePaymentSession | null>(null);
  const [events, setEvents] = useState<PhonePaymentAuditEvent[]>([]);
  const [chain, setChain] = useState<{ valid: boolean; events: number; firstBadSeq: number | null } | null>(null);

  const load = useCallback(async () => {
    if (!canAccess) return;
    setLoading(true); setFailed(false);
    try { setRows(await fetchSessions()); } catch { setFailed(true); } finally { setLoading(false); }
  }, [canAccess]);
  useEffect(() => { void load(); }, [load]);

  const open = async (s: PhonePaymentSession) => {
    setSelected(s); setEvents([]); setChain(null);
    try {
      const [e, c] = await Promise.all([fetchAudit(s.id), verifyChain(s.id)]);
      setEvents(e); setChain(c);
    } catch { toast('Could not load the audit trail.', 'error'); }
  };

  const exportCsv = () => {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([auditToCsv(selected, events)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `phone-payment-audit-${selected.id.slice(0, 8)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Phone Payments">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <Lock size={26} className="text-text-secondary" />
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for billing access.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Phone Payments">
      <div className="mb-6 flex items-center gap-3">
        <button type="button" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard"
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary"><ArrowLeft size={18} /></button>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Phone payments</h1>
          <p className="text-sm text-text-secondary">PCI-safe card payments taken by phone, with a tamper-evident audit trail. Card numbers are never stored.</p>
        </div>
      </div>

      {loading ? <p className="text-sm text-text-secondary">Loading…</p> : failed ? (
        <EmptyState title="Couldn't load phone payments" description="Check your connection and try again." />
      ) : rows.length === 0 ? (
        <EmptyState title="No phone payments yet" description="When your AI receptionist or a team member takes a card by phone, the secure session and its audit trail appear here." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-secondary text-xs uppercase text-text-secondary">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Taken by</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Card</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => void open(r)} className={`cursor-pointer border-t border-border hover:bg-bg-secondary ${selected?.id === r.id ? 'bg-bg-secondary' : ''}`}>
                    <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{r.channel === 'ai_agent' ? 'AI agent' : 'Staff'}</td>
                    <td className="px-3 py-2">{money(r.amount_cents)}</td>
                    <td className="px-3 py-2">{cardLabel(r.card_brand, r.card_last4)}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section aria-label="Audit trail" className="rounded-2xl border border-border p-4">
            {!selected ? <p className="text-sm text-text-secondary">Select a payment to see its audit trail.</p> : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {chain && (chain.valid
                    ? <span className="flex items-center gap-1.5 text-sm font-medium text-success-500"><ShieldCheck size={16} />Chain verified ({chain.events} events)</span>
                    : <span role="alert" className="flex items-center gap-1.5 text-sm font-medium text-danger"><ShieldAlert size={16} />Tampering detected at event {chain.firstBadSeq}</span>)}
                  <Button type="button" variant="secondary" size="sm" onClick={exportCsv} disabled={events.length === 0}><Download size={15} />Export CSV</Button>
                </div>
                <ol className="mt-4 space-y-3">
                  {events.map((e) => (
                    <li key={e.id} className="border-l-2 border-border pl-3">
                      <p className="text-sm font-medium text-text-primary">{EVENT_LABELS[e.event_type] ?? e.event_type}</p>
                      <p className="text-xs text-text-secondary">{new Date(e.created_at).toLocaleTimeString()} · {e.actor_type.replace('_', ' ')}{Object.keys(e.metadata).length ? ` · ${Object.entries(e.metadata).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(', ')}` : ''}</p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
