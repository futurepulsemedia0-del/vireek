import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';

interface AuditRow {
  id: string;
  quote_id: string;
  revenue_cents: number;
  estimated_cost_cents: number;
  margin_pct: number | null;
  margin_floor_pct: number;
  verdict: 'within_floor' | 'blocked' | 'overridden';
  override_reason: string | null;
  created_at: string;
  quotes: { customer_name: string } | null;
}

const VERDICT_STYLES: Record<string, string> = {
  within_floor: 'bg-success-500/10 text-success-500',
  blocked: 'bg-danger-500/10 text-danger-500',
  overridden: 'bg-warning-500/10 text-warning-500',
};

export function MarginGuardrailsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [marginFloor, setMarginFloor] = useState('20');
  const [costRatio, setCostRatio] = useState('55');
  const [savingSettings, setSavingSettings] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSettings = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from('business_profile').select('margin_floor_pct, default_cost_ratio_pct').eq('user_id', user.id).maybeSingle();
    if (data) {
      setMarginFloor(String(data.margin_floor_pct ?? 20));
      setCostRatio(String(data.default_cost_ratio_pct ?? 55));
    }
  }, [user]);

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('margin_guardrail_checks')
      .select('id, quote_id, revenue_cents, estimated_cost_cents, margin_pct, margin_floor_pct, verdict, override_reason, created_at, quotes:quote_id (customer_name)')
      .neq('verdict', 'within_floor')
      .order('created_at', { ascending: false })
      .limit(100);
    setRows((data as unknown as AuditRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchSettings(); fetchAudit(); }, [fetchSettings, fetchAudit]);

  const saveSettings = async () => {
    if (!user) return;
    setSavingSettings(true);
    const { error } = await supabase
      .from('business_profile')
      .update({ margin_floor_pct: Number(marginFloor) || 0, default_cost_ratio_pct: Number(costRatio) || 0 })
      .eq('user_id', user.id);
    setSavingSettings(false);
    if (error) { toast('Could not save guardrail settings.', 'error'); return; }
    toast('Margin guardrail settings saved.', 'success');
  };

  return (
    <DashboardLayout activeLabel="Margin Guardrails">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><ShieldCheck size={24} /></span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">Margin Guardrails &amp; Discount Governance</h1>
          <p className="text-sm text-text-secondary">Every quote is checked against real estimated cost before it can be sent below your margin floor.</p>
        </div>
      </div>

      <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">Guardrail settings</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-text-secondary">
            Margin floor %
            <input value={marginFloor} onChange={(e) => setMarginFloor(e.target.value)} type="number" min="0" max="100" step="0.5" className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
          </label>
          <label className="text-xs text-text-secondary">
            Default cost ratio % <span className="block text-[10px]">(used when a line item isn't in the Price Book)</span>
            <input value={costRatio} onChange={(e) => setCostRatio(e.target.value)} type="number" min="0" max="100" step="0.5" className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
          </label>
          <div className="flex items-end">
            <button type="button" onClick={saveSettings} disabled={savingSettings} className="focus-ring w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {savingSettings ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-text-secondary">Set a real cost on individual services from the Price Book for the most accurate check — otherwise every line item falls back to the default cost ratio above.</p>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-text-primary">Blocked &amp; overridden quotes</h2>
      <p className="mb-3 text-xs text-text-secondary">Every quote that failed the margin floor check, and every override — with the reason on record.</p>
      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">No quotes have hit the margin floor yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Quote</th>
                <th className="px-4 py-3 font-medium">Margin</th>
                <th className="px-4 py-3 font-medium">Floor</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-text-primary">{r.quotes?.customer_name ?? 'Quote'}</td>
                  <td className="px-4 py-3 text-text-secondary">{r.margin_pct === null ? '—' : `${r.margin_pct.toFixed(1)}%`}</td>
                  <td className="px-4 py-3 text-text-secondary">{r.margin_floor_pct}%</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${VERDICT_STYLES[r.verdict]}`}>
                      <AlertTriangle size={11} /> {r.verdict.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{r.override_reason ?? '—'}</td>
                  <td className="px-4 py-3 text-text-secondary">{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardLayout>
  );
}
