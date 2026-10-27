import { useEffect, useState } from 'react';
import { Plus, ExternalLink, BadgeCheck, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  ANCHOR_LABELS, CLOSEOUT_STEP_KEYS, EVIDENCE_KINDS, EVIDENCE_LABELS, RULES_DISCLAIMER, STEP_LABELS,
  programFreshness, safeHttpUrl, saveCloseoutProgram, saveCloseoutSettings, verifyCloseoutProgram,
  type CloseoutAnchor, type CloseoutProgram, type CloseoutSettings, type CloseoutStepKey, type EvidenceKind,
} from '@/lib/installCloseout';

const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

interface Draft {
  step_key: CloseoutStepKey; name: string; administrator: string; anchor: CloseoutAnchor; deadline_days: string;
  requires_pre_approval: boolean; required_evidence: EvidenceKind[]; enrollment: string; value: string;
  auto_attach: boolean; source_url: string; last_verified_on: string; reverify_days: string; notes: string; is_active: boolean;
}

const blank = (): Draft => ({
  step_key: 'warranty', name: '', administrator: '', anchor: 'install_date', deadline_days: '', requires_pre_approval: false,
  required_evidence: [], enrollment: '', value: '', auto_attach: false, source_url: '', last_verified_on: '',
  reverify_days: '180', notes: '', is_active: false,
});

const fromProgram = (p: CloseoutProgram): Draft => ({
  step_key: p.step_key, name: p.name, administrator: p.administrator ?? '', anchor: p.anchor,
  deadline_days: p.deadline_days == null ? '' : String(p.deadline_days), requires_pre_approval: p.requires_pre_approval,
  required_evidence: p.required_evidence, enrollment: p.enrollment_requirements.join('\n'),
  value: p.estimated_value_cents == null ? '' : String(p.estimated_value_cents / 100), auto_attach: p.auto_attach,
  source_url: p.source_url ?? '', last_verified_on: p.last_verified_on ?? '', reverify_days: String(p.reverify_days),
  notes: p.notes ?? '', is_active: p.is_active,
});

export function CloseoutRulesPanel({ programs, settings, today, onChanged }: {
  programs: CloseoutProgram[]; settings: CloseoutSettings; today: string; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: d.name, administrator: d.administrator, anchor: d.anchor,
        deadline_days: d.deadline_days === '' ? null : Number(d.deadline_days),
        requires_pre_approval: d.requires_pre_approval, required_evidence: d.required_evidence,
        enrollment_requirements: d.enrollment.split('\n').map((x) => x.trim()).filter(Boolean),
        estimated_value_cents: d.value === '' ? null : Math.round(Number(d.value) * 100),
        auto_attach: d.auto_attach, source_url: d.source_url, last_verified_on: d.last_verified_on || null,
        reverify_days: Number(d.reverify_days) || 180, notes: d.notes, is_active: d.is_active,
      };
      if (!editing.id) payload.step_key = d.step_key;
      await saveCloseoutProgram(editing.id, payload);
      toast('Rule saved.', 'success');
      setEditing(null);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the rule.', 'error');
    } finally { setBusy(false); }
  };

  const saveSettings = async () => {
    setBusy(true);
    try { await saveCloseoutSettings(s); toast('Escalation settings saved.', 'success'); onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-text-primary" role="note">
        <strong>Not legal advice.</strong> {RULES_DISCLAIMER}
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text-primary">Program rules</h2>
        <Button size="sm" onClick={() => setEditing({ id: null, draft: blank() })}><Plus size={14} />New rule</Button>
      </div>

      {programs.length === 0 ? (
        <EmptyState icon={BadgeCheck} title="No rules yet"
          description="Add the deadlines and required documents for each permit authority, manufacturer or rebate program. Each rule needs a source URL and a verified date before it can be used."
          action={{ label: 'Add the first rule', onClick: () => setEditing({ id: null, draft: blank() }) }} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {programs.map((p) => {
            const fresh = programFreshness(p, today);
            const url = safeHttpUrl(p.source_url);
            return (
              <Card key={p.id} className="!p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{p.name}</p>
                    <p className="text-xs text-text-secondary">{STEP_LABELS[p.step_key]} · {p.administrator ?? 'no administrator'}</p>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${p.is_active ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-secondary'}`}>{p.is_active ? 'Active' : 'Draft'}</span>
                </div>
                <p className="mt-2 text-xs text-text-secondary">
                  {p.deadline_days == null ? 'No deadline' : `${p.deadline_days} days after ${ANCHOR_LABELS[p.anchor].toLowerCase()}`}
                  {p.requires_pre_approval ? ' · pre-approval required' : ''}
                </p>
                <p className="mt-1 text-xs text-text-secondary">Needs: {p.required_evidence.length ? p.required_evidence.map((k) => EVIDENCE_LABELS[k]).join(', ') : 'nothing specified'}</p>
                <p className={`mt-2 flex items-center gap-1 text-xs ${fresh === 'fresh' ? 'text-text-secondary' : 'font-semibold text-warning-500'}`}>
                  {fresh !== 'fresh' && <AlertTriangle size={12} />}
                  {fresh === 'unverified' ? 'Unverified — add a source and date' : `Verified ${p.last_verified_on}${fresh === 'stale' ? ' — time to re-verify' : ''}`}
                  {url && <a href={url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-accent underline">source <ExternalLink size={11} /></a>}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ id: p.id, draft: fromProgram(p) })}>Edit</Button>
                  {p.source_url && (
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={async () => { try { await verifyCloseoutProgram(p.id); toast('Marked as verified today.', 'success'); onChanged(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed.', 'error'); } }}>
                      I re-checked it today
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <Card className="!p-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">{editing.id ? 'Edit rule' : 'New rule'}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="rule-step">Step</label>
              <select id="rule-step" className={field} disabled={!!editing.id} value={editing.draft.step_key}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, step_key: e.target.value as CloseoutStepKey } })}>
                {CLOSEOUT_STEP_KEYS.map((k) => <option key={k} value={k}>{STEP_LABELS[k]}</option>)}
              </select>
            </div>
            <Input label="Name" required value={editing.draft.name} maxLength={160} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} />
            <Input label="Administrator (utility, manufacturer, authority)" value={editing.draft.administrator} maxLength={160} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, administrator: e.target.value } })} />
            <Input label="Estimated value per job ($) — estimate only" type="number" min={0} value={editing.draft.value} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, value: e.target.value } })} />
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor="rule-anchor">Deadline counts from</label>
              <select id="rule-anchor" className={field} value={editing.draft.anchor} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, anchor: e.target.value as CloseoutAnchor } })}>
                {(Object.keys(ANCHOR_LABELS) as CloseoutAnchor[]).map((k) => <option key={k} value={k}>{ANCHOR_LABELS[k]}</option>)}
              </select>
            </div>
            <Input label="Days allowed (blank = no deadline)" type="number" min={0} max={1095} value={editing.draft.deadline_days} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, deadline_days: e.target.value } })} />
            <Input label="Source URL (where you verified this rule)" type="url" value={editing.draft.source_url} placeholder="https://" onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, source_url: e.target.value } })} />
            <Input label="Last verified on" type="date" value={editing.draft.last_verified_on} max={today} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, last_verified_on: e.target.value } })} />
            <Input label="Re-verify every (days)" type="number" min={30} max={730} value={editing.draft.reverify_days} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, reverify_days: e.target.value } })} />
          </div>

          <fieldset className="mt-3">
            <legend className="mb-1 text-sm font-medium text-text-primary">Required documents / data</legend>
            <div className="flex flex-wrap gap-2">
              {EVIDENCE_KINDS.map((k) => {
                const on = editing.draft.required_evidence.includes(k);
                return (
                  <label key={k} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                    <input type="checkbox" className="sr-only" checked={on}
                      onChange={() => setEditing({ ...editing, draft: { ...editing.draft, required_evidence: on ? editing.draft.required_evidence.filter((x) => x !== k) : [...editing.draft.required_evidence, k] } })} />
                    {EVIDENCE_LABELS[k]}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-3">
            <Textarea label="Enrollment requirements (one per line)" rows={3} value={editing.draft.enrollment} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, enrollment: e.target.value } })} />
          </div>
          <div className="mt-3">
            <Textarea label="Notes" rows={2} value={editing.draft.notes} maxLength={2000} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, notes: e.target.value } })} />
          </div>

          <div className="mt-3 flex flex-wrap gap-4 text-sm text-text-primary">
            <label className="flex items-center gap-2"><input type="checkbox" checked={editing.draft.requires_pre_approval} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, requires_pre_approval: e.target.checked } })} />Requires pre-approval before install (blocks job start)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={editing.draft.auto_attach} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, auto_attach: e.target.checked } })} />Attach automatically to new closeouts</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={editing.draft.is_active} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, is_active: e.target.checked } })} />Active (needs source URL + verified date)</label>
          </div>

          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={busy || editing.draft.name.trim().length < 2} onClick={save}>Save rule</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <Card className="!p-5">
        <h2 className="text-base font-semibold text-text-primary">Escalation</h2>
        <p className="mb-3 text-xs text-text-secondary">Days before a deadline when each person is alerted. Technician ≥ office ≥ owner. 0 = on the deadline day.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Technician (days left)" type="number" min={1} max={90} value={s.technician_days} onChange={(e) => setS({ ...s, technician_days: Number(e.target.value) })} />
          <Input label="Office (days left)" type="number" min={0} max={60} value={s.office_days} onChange={(e) => setS({ ...s, office_days: Number(e.target.value) })} />
          <Input label="Owner (days left)" type="number" min={-30} max={30} value={s.owner_days} onChange={(e) => setS({ ...s, owner_days: Number(e.target.value) })} />
        </div>
        <div className="mt-3"><Button size="sm" variant="secondary" disabled={busy} onClick={saveSettings}>Save escalation settings</Button></div>
      </Card>
    </div>
  );
}
