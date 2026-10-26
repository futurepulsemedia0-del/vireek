import { useState } from 'react';
import { Plus, Pencil, Trash2, ExternalLink, AlertTriangle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { deleteProgram, saveProgram, type AuditData, type ProgramRow } from '@/lib/supplierAudit/api';
import { programFreshness } from '@/lib/supplierAudit/engine';
import { isYmd, todayInZone } from '@/lib/supplierAudit/money';
import { Card, DISCLAIMER, PROGRAM_TYPE_LABELS, Pill, btnGhost, btnPrimary, centsToDollars, dollarsToCents, inputClass } from './shared';

interface Form {
  id?: string; vendor_id: string; name: string; program_type: ProgramRow['program_type']; status: ProgramRow['status']; period_start: string; period_end: string; currency: string;
  enrollment_status: ProgramRow['enrollment_status']; claim_deadline: string; required_documents: string; documents_on_file: string; source_url: string; last_verified_at: string; notes: string;
  tiers: { threshold: string; rate: string }[]; tier_mode: 'retroactive_all' | 'marginal'; price_schedule: string; tolerance_pct: string; tolerance_dollars: string; coop_pct: string; coop_cap: string; override_json: string;
}
const blank = (): Form => ({ vendor_id: '', name: '', program_type: 'volume_rebate', status: 'draft', period_start: '', period_end: '', currency: 'USD', enrollment_status: 'unknown', claim_deadline: '', required_documents: '', documents_on_file: '', source_url: '', last_verified_at: '', notes: '', tiers: [{ threshold: '', rate: '' }], tier_mode: 'retroactive_all', price_schedule: '', tolerance_pct: '', tolerance_dollars: '', coop_pct: '', coop_cap: '', override_json: '' });
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);

function fromRow(r: ProgramRow): Form {
  const k = r.rules as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: r.id, vendor_id: r.vendor_id, name: r.name, program_type: r.program_type, status: r.status, period_start: r.period_start ?? '', period_end: r.period_end ?? '', currency: r.currency,
    enrollment_status: r.enrollment_status, claim_deadline: r.claim_deadline ?? '', required_documents: r.required_documents.join(', '), documents_on_file: r.documents_on_file.join(', '), source_url: r.source_url ?? '',
    last_verified_at: r.last_verified_at ?? '', notes: r.notes ?? '',
    tiers: Array.isArray(k.tiers) && k.tiers.length ? k.tiers.map((t: any) => ({ threshold: centsToDollars(t.threshold_cents), rate: String((t.rate_bps ?? 0) / 100) })) : [{ threshold: '', rate: '' }], // eslint-disable-line @typescript-eslint/no-explicit-any
    tier_mode: k.tier_mode === 'marginal' ? 'marginal' : 'retroactive_all',
    price_schedule: Array.isArray(k.price_schedule) ? k.price_schedule.map((p: any) => `${p.sku},${centsToDollars(p.unit_price_cents)}`).join('\n') : '', // eslint-disable-line @typescript-eslint/no-explicit-any
    tolerance_pct: k.tolerance_bps ? String(k.tolerance_bps / 100) : '', tolerance_dollars: centsToDollars(k.tolerance_cents || null), coop_pct: k.coop_accrual_bps ? String(k.coop_accrual_bps / 100) : '',
    coop_cap: centsToDollars(k.coop_cap_cents ?? null), override_json: Object.keys(r.rules_override ?? {}).length ? JSON.stringify(r.rules_override, null, 2) : '',
  };
}

/** Builds the rules JSON; throws a human message for anything that is not a clean number (never guessed). */
function buildRules(f: Form): { rules: Record<string, unknown>; override: Record<string, unknown> } {
  const rules: Record<string, unknown> = {};
  if (f.program_type === 'volume_rebate' || f.program_type === 'patronage') {
    const tiers = f.tiers.filter((t) => t.threshold.trim() || t.rate.trim()).map((t) => {
      const c = dollarsToCents(t.threshold); const pct = Number(t.rate);
      if (c === null || !Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('Each tier needs a spend threshold (e.g. 100000.00) and a rate between 0 and 100%.');
      return { threshold_cents: c, rate_bps: Math.round(pct * 100) };
    });
    if (f.status === 'active' && tiers.length === 0) throw new Error('An active rebate program needs at least one tier.');
    rules.tiers = tiers; rules.tier_mode = f.tier_mode;
  }
  if (f.program_type === 'price_agreement') {
    const rows = f.price_schedule.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [sku, price] = l.split(',').map((x) => x.trim()); const c = price ? dollarsToCents(price) : null;
      if (!sku || c === null) throw new Error(`Price schedule line "${l}" must look like SKU,12.34`);
      return { sku: sku.toUpperCase(), unit_price_cents: c };
    });
    if (f.status === 'active' && rows.length === 0) throw new Error('An active price agreement needs a price schedule.');
    rules.price_schedule = rows;
    const pct = f.tolerance_pct.trim() ? Number(f.tolerance_pct) : 0; const dol = f.tolerance_dollars.trim() ? dollarsToCents(f.tolerance_dollars) : 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || dol === null) throw new Error('Tolerance must be a valid percentage and dollar amount.');
    rules.tolerance_bps = Math.round(pct * 100); rules.tolerance_cents = dol;
  }
  if (f.program_type === 'co_op') {
    const pct = Number(f.coop_pct); if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('Co-op accrual must be a percentage between 0 and 100.');
    rules.coop_accrual_bps = Math.round(pct * 100);
    if (f.coop_cap.trim()) { const c = dollarsToCents(f.coop_cap); if (c === null) throw new Error('Co-op cap must be a dollar amount.'); rules.coop_cap_cents = c; }
  }
  let override: Record<string, unknown> = {};
  if (f.override_json.trim()) { try { const o = JSON.parse(f.override_json); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(); override = o; } catch { throw new Error('Account override must be a valid JSON object, e.g. {"tolerance_bps": 100}.'); } }
  return { rules, override };
}

export function ProgramsPanel({ data, reload, timeZone }: { data: AuditData; reload: () => Promise<void>; timeZone: string }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayInZone(new Date(), timeZone);
  const vname = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? 'Supplier';
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((p) => (p ? { ...p, [k]: v } : p));

  const submit = async () => {
    if (!form) return;
    try {
      if (!form.vendor_id || !form.name.trim()) throw new Error('Choose a vendor and give the program a name.');
      for (const [l, d] of [['Period start', form.period_start], ['Period end', form.period_end], ['Claim deadline', form.claim_deadline], ['Last verified', form.last_verified_at]] as const) if (d && !isYmd(d)) throw new Error(`${l} is not a valid date.`);
      if (form.period_start && form.period_end && form.period_end < form.period_start) throw new Error('The period end is before the period start.');
      if (form.source_url && !/^https?:\/\//i.test(form.source_url)) throw new Error('Source URL must start with http:// or https://');
      if (form.status === 'active' && !form.source_url) throw new Error('Add the source URL before activating — every program must point to where its rules came from.');
      const { rules, override } = buildRules(form);
      setBusy(true);
      await saveProgram(data.ownerId, {
        id: form.id, vendor_id: form.vendor_id, name: form.name.trim(), program_type: form.program_type, status: form.status, period_start: form.period_start || null, period_end: form.period_end || null,
        currency: form.currency.toUpperCase(), rules, rules_override: override, enrollment_status: form.enrollment_status, claim_deadline: form.claim_deadline || null,
        required_documents: list(form.required_documents), documents_on_file: list(form.documents_on_file), source_url: form.source_url.trim() || null, last_verified_at: form.last_verified_at || null, notes: form.notes.trim() || null,
      });
      setForm(null); await reload(); toast('Program saved', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div role="note" className="flex gap-2 rounded-2xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-primary"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" /><span>{DISCLAIMER}</span></div>
      {!form && <button type="button" className={btnPrimary} onClick={() => setForm(blank())}><Plus size={16} /> Add program</button>}

      {form && (
        <Card title={form.id ? 'Edit program' : 'New program'}>
          <div className="grid gap-3 sm:grid-cols-6">
            <select className={`${inputClass} sm:col-span-2`} value={form.vendor_id} onChange={(e) => set('vendor_id', e.target.value)} aria-label="Vendor"><option value="">Vendor…</option>{data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            <input className={`${inputClass} sm:col-span-2`} placeholder="Program name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={160} />
            <select className={inputClass} value={form.program_type} onChange={(e) => set('program_type', e.target.value as Form['program_type'])} aria-label="Type">{Object.entries(PROGRAM_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select className={inputClass} value={form.status} onChange={(e) => set('status', e.target.value as Form['status'])} aria-label="Status"><option value="draft">Draft</option><option value="active">Active</option><option value="archived">Archived</option></select>
            <label className="text-xs text-text-secondary">Period start<input type="date" className={inputClass} value={form.period_start} onChange={(e) => set('period_start', e.target.value)} /></label>
            <label className="text-xs text-text-secondary">Period end<input type="date" className={inputClass} value={form.period_end} onChange={(e) => set('period_end', e.target.value)} /></label>
            <label className="text-xs text-text-secondary">Claim deadline<input type="date" className={inputClass} value={form.claim_deadline} onChange={(e) => set('claim_deadline', e.target.value)} /></label>
            <label className="text-xs text-text-secondary">Enrollment<select className={inputClass} value={form.enrollment_status} onChange={(e) => set('enrollment_status', e.target.value as Form['enrollment_status'])}><option value="unknown">Unknown</option><option value="enrolled">Enrolled</option><option value="not_required">Not required</option><option value="not_enrolled">Not enrolled</option></select></label>
            <label className="text-xs text-text-secondary">Currency<input className={inputClass} value={form.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></label>
            <label className="text-xs text-text-secondary">Last verified<input type="date" className={inputClass} value={form.last_verified_at} onChange={(e) => set('last_verified_at', e.target.value)} /></label>
            <input className={`${inputClass} sm:col-span-6`} placeholder="Source URL (where these rules are published) — required to activate" value={form.source_url} onChange={(e) => set('source_url', e.target.value)} />
            <input className={`${inputClass} sm:col-span-3`} placeholder="Required documents (comma separated)" value={form.required_documents} onChange={(e) => set('required_documents', e.target.value)} />
            <input className={`${inputClass} sm:col-span-3`} placeholder="Documents you have on file (comma separated)" value={form.documents_on_file} onChange={(e) => set('documents_on_file', e.target.value)} />

            {(form.program_type === 'volume_rebate' || form.program_type === 'patronage') && (
              <div className="space-y-2 sm:col-span-6"><p className="text-xs font-medium text-text-secondary">Tiers (annual qualifying spend → rebate %)</p>
                {form.tiers.map((t, i) => (<div key={i} className="grid grid-cols-5 gap-2"><input className={`${inputClass} col-span-2`} inputMode="decimal" placeholder="Spend threshold $" value={t.threshold} onChange={(e) => set('tiers', form.tiers.map((x, j) => (j === i ? { ...x, threshold: e.target.value } : x)))} /><input className={`${inputClass} col-span-2`} inputMode="decimal" placeholder="Rate %" value={t.rate} onChange={(e) => set('tiers', form.tiers.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} /><button type="button" className={btnGhost} aria-label="Remove tier" onClick={() => set('tiers', form.tiers.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>))}
                <div className="flex flex-wrap items-center gap-3"><button type="button" className={btnGhost} onClick={() => set('tiers', [...form.tiers, { threshold: '', rate: '' }])}><Plus size={14} /> Add tier</button>
                  <select className={`${inputClass} w-auto`} value={form.tier_mode} onChange={(e) => set('tier_mode', e.target.value as Form['tier_mode'])} aria-label="Tier mode"><option value="retroactive_all">Rate applies to ALL spend (retroactive)</option><option value="marginal">Each band at its own rate (marginal)</option></select></div></div>)}
            {form.program_type === 'price_agreement' && (<>
              <textarea className={`${inputClass} sm:col-span-6`} rows={5} placeholder={'Price schedule, one per line: SKU,agreed unit price\nEX-100,12.50'} value={form.price_schedule} onChange={(e) => set('price_schedule', e.target.value)} />
              <input className={`${inputClass} sm:col-span-3`} inputMode="decimal" placeholder="Tolerance % (e.g. 1)" value={form.tolerance_pct} onChange={(e) => set('tolerance_pct', e.target.value)} />
              <input className={`${inputClass} sm:col-span-3`} inputMode="decimal" placeholder="Tolerance $ per unit (e.g. 0.10)" value={form.tolerance_dollars} onChange={(e) => set('tolerance_dollars', e.target.value)} /></>)}
            {form.program_type === 'co_op' && (<>
              <input className={`${inputClass} sm:col-span-3`} inputMode="decimal" placeholder="Co-op accrual % of spend" value={form.coop_pct} onChange={(e) => set('coop_pct', e.target.value)} />
              <input className={`${inputClass} sm:col-span-3`} inputMode="decimal" placeholder="Annual cap $ (optional)" value={form.coop_cap} onChange={(e) => set('coop_cap', e.target.value)} /></>)}
            <details className="sm:col-span-6"><summary className="cursor-pointer text-xs text-text-secondary">Per-account override (advanced, JSON layered over the rules above)</summary>
              <textarea className={`${inputClass} mt-2 font-mono text-xs`} rows={4} placeholder='{"tolerance_bps": 100}' value={form.override_json} onChange={(e) => set('override_json', e.target.value)} /></details>
            <textarea className={`${inputClass} sm:col-span-6`} rows={2} placeholder="Notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            <div className="flex gap-2 sm:col-span-6"><button type="button" className={btnPrimary} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save program'}</button><button type="button" className={btnGhost} onClick={() => setForm(null)}>Cancel</button></div>
          </div>
        </Card>)}

      <Card title="Programs">
        {data.programRows.length === 0 ? <p className="text-sm text-text-secondary">No programs yet. Add the rebate, patronage, co-op and price agreements you have with each distributor — the audit only checks programs you enter.</p> : (
          <ul className="divide-y divide-border">{data.programRows.map((r) => {
            const fr = programFreshness({ lastVerifiedAt: r.last_verified_at }, today);
            return (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                <span className="min-w-0"><span className="font-medium text-text-primary">{vname(r.vendor_id)} — {r.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2"><Pill cls="bg-accent/10 text-accent">{PROGRAM_TYPE_LABELS[r.program_type]}</Pill><Pill cls="bg-bg-tertiary text-text-secondary">{r.status}</Pill><Pill cls="bg-bg-tertiary text-text-secondary">enrollment: {r.enrollment_status.replace('_', ' ')}</Pill>
                    {fr.stale && <Pill cls="bg-warning-500/10 text-warning-500">{r.last_verified_at ? 'Verified >12 months ago' : 'Never verified'}</Pill>}</span>
                  <span className="mt-1 block text-xs text-text-secondary">{r.period_start ?? '—'} → {r.period_end ?? '—'} · last verified {r.last_verified_at ?? 'never'} · {r.source_url ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline">source <ExternalLink size={11} /></a> : 'no source URL'}</span></span>
                <span className="flex gap-2"><button type="button" className={btnGhost} aria-label="Edit program" onClick={() => setForm(fromRow(r))}><Pencil size={14} /></button>
                  <button type="button" className={btnGhost} aria-label="Delete program" onClick={async () => { if (!window.confirm('Delete this program? Findings based on it will be marked as no longer applying on the next run.')) return; try { await deleteProgram(r.id); await reload(); } catch (e) { toast(e instanceof Error ? e.message : 'Delete failed', 'error'); } }}><Trash2 size={14} /></button></span>
              </li>);
          })}</ul>)}
      </Card>
    </div>
  );
}
