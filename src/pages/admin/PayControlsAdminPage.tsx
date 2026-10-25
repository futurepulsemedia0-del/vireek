// /staff/pay-controls — Vireek staff only. The kill switch, mode, fee schedule/caps, tenant freezes,
// disclosure review and the audit trail for Pay & Capital. Every change needs a written reason and is
// re-validated by staff_pay_update_control() (this page is convenience, not the security boundary).
import { useCallback, useEffect, useState } from 'react';
import { Loader2, OctagonX } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/pay/PayShared';
import { useToast } from '@/contexts/ToastContext';
import { useSEO } from '@/lib/seo';
import {
  staffKillAll, staffListAudit, staffListControls, staffListDisclosures, staffListFrozen, staffMarkReviewed, staffSetFreeze, staffUpdateControl,
  type AuditRow, type DisclosureRow, type FrozenRow,
} from '@/lib/payApi';
import { PRODUCT_LABEL, describeControl, formatCents, validateControlPatch, type ControlRow } from '@/lib/pay';

export function PayControlsAdminPage() {
  useSEO({ title: 'Pay controls', description: 'Staff controls for Vireek Pay & Capital.' });
  const { toast } = useToast();
  const [controls, setControls] = useState<ControlRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [frozen, setFrozen] = useState<FrozenRow[]>([]);
  const [disclosures, setDisclosures] = useState<DisclosureRow[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, Partial<ControlRow>>>({});
  const [freeze, setFreeze] = useState({ tenant: '', product: 'all', why: '' });

  const reload = useCallback(async () => {
    try {
      const [c, a, f, d] = await Promise.all([staffListControls(), staffListAudit(), staffListFrozen(), staffListDisclosures()]);
      setControls(c); setAudit(a); setFrozen(f); setDisclosures(d); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function act(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Failed.', 'error'); }
    finally { setBusy(false); }
  }

  const patchOf = (c: ControlRow) => edit[c.product] ?? {};
  const setField = (c: ControlRow, k: keyof ControlRow, v: unknown) => setEdit((e) => ({ ...e, [c.product]: { ...e[c.product], [k]: v } }));

  function save(c: ControlRow, extra: Partial<ControlRow> = {}) {
    const patch = { ...patchOf(c), ...extra };
    const problem = validateControlPatch(c, patch, reason);
    if (problem) return toast(problem, 'error');
    void act(async () => { await staffUpdateControl(c.product, patch as Record<string, unknown>, reason.trim()); setEdit((e) => ({ ...e, [c.product]: {} })); }, `${PRODUCT_LABEL[c.product]} updated`);
  }

  function killAll() {
    if (reason.trim().length < 8) return toast('Write a reason of at least 8 characters.', 'error');
    if (!window.confirm('Turn OFF every Pay & Capital product immediately for all tenants?')) return;
    void act(async () => { await staffKillAll(reason.trim()); }, 'All products killed');
  }

  if (!controls) return <div className="min-h-screen bg-bg-primary"><Header /><div className="flex justify-center py-20">{error ? <p role="alert" className="text-danger">{error}</p> : <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />}</div></div>;

  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-bold text-text-primary">Pay & Capital controls</h1>

        <section className="rounded-xl border border-danger/40 bg-danger/5 p-4">
          <Input label="Reason (required for every change, min 8 characters)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Partner incident INC-123 — pausing all money movement" />
          <Button className="mt-3" variant="secondary" disabled={busy} onClick={killAll}><OctagonX size={16} className="mr-2 inline" />Kill ALL products now</Button>
        </section>

        {controls.map((c) => {
          const st = describeControl(c); const p = { ...c, ...patchOf(c) } as ControlRow;
          return (
            <section key={c.product} className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-text-primary">{PRODUCT_LABEL[c.product]}</h2>
                <Pill tone={st.tone}>{st.label}</Pill>
              </div>
              {c.kill_reason && <p className="mt-1 text-xs text-danger">Killed: {c.kill_reason}</p>}
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-text-secondary">Mode
                  <select className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary p-2 text-sm text-text-primary" value={p.mode} onChange={(e) => setField(c, 'mode', e.target.value)}>
                    <option value="sandbox">Sandbox</option><option value="live">Live (needs partner + reviewed terms)</option>
                  </select>
                </label>
                <Input label="Partner name" value={p.partner_name ?? ''} onChange={(e) => setField(c, 'partner_name', e.target.value)} />
                <Input label="Partner agreement ref" value={p.partner_agreement_ref ?? ''} onChange={(e) => setField(c, 'partner_agreement_ref', e.target.value)} />
                <Input label="Fee (basis points)" inputMode="numeric" value={String(p.fee_bps)} onChange={(e) => setField(c, 'fee_bps', Number(e.target.value) || 0)} />
                <Input label="Min fee (cents)" inputMode="numeric" value={String(p.min_fee_cents)} onChange={(e) => setField(c, 'min_fee_cents', Number(e.target.value) || 0)} />
                <Input label="Max fee (cents)" inputMode="numeric" value={String(p.max_fee_cents)} onChange={(e) => setField(c, 'max_fee_cents', Number(e.target.value) || 0)} />
                <Input label={`Max single (${formatCents(p.max_single_cents)})`} inputMode="numeric" value={String(p.max_single_cents)} onChange={(e) => setField(c, 'max_single_cents', Number(e.target.value) || 0)} />
                <Input label={`Daily cap per tenant (${formatCents(p.max_daily_tenant_cents)})`} inputMode="numeric" value={String(p.max_daily_tenant_cents)} onChange={(e) => setField(c, 'max_daily_tenant_cents', Number(e.target.value) || 0)} />
                <Input label="Max % of accrued (EWA)" inputMode="numeric" value={String(p.max_pct_of_accrued)} onChange={(e) => setField(c, 'max_pct_of_accrued', Number(e.target.value) || 0)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => save(c)}>Save settings</Button>
                {!c.killed_at && c.enabled
                  ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (reason.trim().length < 8) return toast('Write a reason of at least 8 characters.', 'error'); void act(async () => { await staffUpdateControl(c.product, { enabled: false }, reason.trim()); }, 'Turned off'); }}>Turn off</Button>
                  : <Button size="sm" variant="secondary" disabled={busy} onClick={() => save(c, { enabled: true })}>{c.killed_at ? 'Re-enable' : 'Turn on'}</Button>}
              </div>
            </section>
          );
        })}

        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="text-lg font-semibold text-text-primary">Disclosures</h2>
          <p className="text-xs text-text-secondary">A product cannot go live until the latest version of each of its disclosures is marked reviewed by counsel.</p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {disclosures.map((d) => (
              <li key={`${d.key}-${d.version}`} className="flex items-center justify-between gap-3 py-2">
                <span className="text-text-primary">{d.key} v{d.version} — {d.title}</span>
                {d.legal_reviewed ? <Pill tone="success">Reviewed: {d.reviewed_by}</Pill> : (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => { const ref = window.prompt('Reviewer reference (counsel name or memo id):'); if (ref) void act(() => staffMarkReviewed(d.key, d.version, ref), 'Marked reviewed'); }}>Mark reviewed</Button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="text-lg font-semibold text-text-primary">Tenant freeze</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <Input label="Tenant (owner id)" value={freeze.tenant} onChange={(e) => setFreeze({ ...freeze, tenant: e.target.value.trim() })} />
            <label className="text-xs text-text-secondary">Product
              <select className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary p-2 text-sm text-text-primary" value={freeze.product} onChange={(e) => setFreeze({ ...freeze, product: e.target.value })}>
                <option value="all">All products</option>{controls.map((c) => <option key={c.product} value={c.product}>{PRODUCT_LABEL[c.product]}</option>)}
              </select>
            </label>
            <Input label="Reason" value={freeze.why} onChange={(e) => setFreeze({ ...freeze, why: e.target.value })} />
          </div>
          <Button className="mt-3" size="sm" disabled={busy || !freeze.tenant || freeze.why.trim().length < 8} onClick={() => act(() => staffSetFreeze(freeze.tenant, freeze.product, true, freeze.why.trim()), 'Tenant frozen')}>Freeze tenant</Button>
          <ul className="mt-3 divide-y divide-border text-sm">
            {frozen.map((f) => (
              <li key={`${f.tenant_id}-${f.product}`} className="flex items-center justify-between gap-3 py-2">
                <span className="text-text-primary">{f.company_name ?? f.email ?? f.tenant_id} · {f.product} — {f.reason}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => staffSetFreeze(f.tenant_id, f.product, false, 'unfrozen by staff'), 'Unfrozen')}>Unfreeze</Button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-bg-secondary p-4">
          <h2 className="text-lg font-semibold text-text-primary">Audit trail</h2>
          <ul className="mt-2 divide-y divide-border text-xs text-text-secondary">
            {audit.map((a) => <li key={a.id} className="py-2"><span className="font-medium text-text-primary">{a.subject}</span> · {a.action} · {a.actor_email ?? 'system'} · {new Date(a.created_at).toLocaleString()}{a.reason ? ` — ${a.reason}` : ''}</li>)}
          </ul>
        </section>
      </main>
    </div>
  );
}
