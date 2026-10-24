import { useMemo, useState } from 'react';
import { Clock3, Pencil, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { deleteRuleSet, saveRuleSet, setRuleSetReview, type RuleSetRow } from '@/lib/prevailingWageApi';
import { isIsoDate, validateRuleSetInput, type FringeOvertimeMode, type SeventhDayRule } from '@/lib/prevailingWage';
import { DAY_NAMES, RULE_SET_TEMPLATES, describeRuleSet, type RuleSetValues } from '@/lib/prevailingWageExport';
import { Pill, ReviewBadge, ReviewControl, SectionTitle, Select, errMsg } from './shared';

interface Props {
  canEdit: boolean;
  ruleSets: RuleSetRow[];
  loading: boolean;
  reload: () => Promise<void>;
}

interface Form {
  id?: string;
  name: string;
  description: string;
  active: boolean;
  workweekStartDow: string;
  weeklyOtAfter: string;
  dailyOtAfter: string;
  dailyDtAfter: string;
  otMultiplier: string;
  dtMultiplier: string;
  seventhDayRule: SeventhDayRule;
  seventhDayOtHours: string;
  saturdayMultiplier: string;
  sundayMultiplier: string;
  holidayMultiplier: string;
  holidays: string;
  fringeOvertimeMode: FringeOvertimeMode;
}

const optional = (v: number | null): string => (v === null ? '' : String(v));

const fromValues = (v: RuleSetValues, extra: { id?: string; description?: string | null; active?: boolean } = {}): Form => ({
  id: extra.id,
  name: v.name,
  description: extra.description ?? '',
  active: extra.active ?? true,
  workweekStartDow: String(v.workweekStartDow),
  weeklyOtAfter: String(v.weeklyOtAfter),
  dailyOtAfter: optional(v.dailyOtAfter),
  dailyDtAfter: optional(v.dailyDtAfter),
  otMultiplier: String(v.otMultiplier),
  dtMultiplier: String(v.dtMultiplier),
  seventhDayRule: v.seventhDayRule,
  seventhDayOtHours: String(v.seventhDayOtHours),
  saturdayMultiplier: optional(v.saturdayMultiplier),
  sundayMultiplier: optional(v.sundayMultiplier),
  holidayMultiplier: optional(v.holidayMultiplier),
  holidays: v.holidays.join('\n'),
  fringeOvertimeMode: v.fringeOvertimeMode,
});

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

function toValues(f: Form): RuleSetValues {
  return {
    name: f.name,
    workweekStartDow: Number(f.workweekStartDow),
    dailyOtAfter: numOrNull(f.dailyOtAfter),
    dailyDtAfter: numOrNull(f.dailyDtAfter),
    weeklyOtAfter: Number(f.weeklyOtAfter),
    seventhDayRule: f.seventhDayRule,
    seventhDayOtHours: Number(f.seventhDayOtHours),
    otMultiplier: Number(f.otMultiplier),
    dtMultiplier: Number(f.dtMultiplier),
    saturdayMultiplier: numOrNull(f.saturdayMultiplier),
    sundayMultiplier: numOrNull(f.sundayMultiplier),
    holidayMultiplier: numOrNull(f.holidayMultiplier),
    holidays: f.holidays.split(/[\s,;]+/).map((h) => h.trim()).filter(Boolean),
    fringeOvertimeMode: f.fringeOvertimeMode,
  };
}

export function OvertimeRulesTab({ canEdit, ruleSets, loading, reload }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<RuleSetRow | null>(null);
  const [reviewOpenId, setReviewOpenId] = useState<string | null>(null);

  const draftValues = useMemo(() => (form ? toValues(form) : null), [form]);
  const livePreview = useMemo(() => {
    if (!draftValues || validateRuleSetInput(draftValues)) return [];
    return describeRuleSet({ ...draftValues, id: 'preview', legalReviewStatus: 'unreviewed' });
  }, [draftValues]);

  const startNew = (templateKey?: string) => {
    const t = RULE_SET_TEMPLATES.find((x) => x.key === templateKey) ?? RULE_SET_TEMPLATES[0];
    setError(null);
    setForm(fromValues(t.values));
  };

  const startEdit = (r: RuleSetRow) => {
    setError(null);
    setForm(fromValues(r, { id: r.id, description: r.description, active: r.active }));
  };

  const submit = async () => {
    if (!form || !draftValues) return;
    const dates = draftValues.holidays;
    if (dates.some((d) => !isIsoDate(d))) return setError('Holidays must be dates like 2027-07-05, one per line.');
    const problem = validateRuleSetInput(draftValues);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await saveRuleSet({ ...draftValues, id: form.id, description: form.description, active: form.active });
      toast('Rule set saved. Legal review was reset if rules changed.', 'success');
      setForm(null);
      await reload();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const setReview = async (id: string, status: 'unreviewed' | 'in_review' | 'approved', reviewer: string) => {
    setBusy(true);
    try {
      await setRuleSetReview(id, status, reviewer);
      toast(status === 'approved' ? 'Marked as legally reviewed.' : 'Review status updated.', 'success');
      await reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteRuleSet(deleting.id);
      toast('Rule set deleted.', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setDeleting(null);
      await reload();
    }
  };

  if (loading) return <SkeletonCardList count={3} />;

  const f = form;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle hint="The overtime logic is data. Pick the rule set a job follows; change it here without touching code.">Overtime rule sets</SectionTitle>
        {canEdit && (
          <Button size="sm" onClick={() => startNew()}>
            <Plus size={14} /> New rule set
          </Button>
        )}
      </div>

      {ruleSets.length === 0 && !f && (
        <EmptyState
          icon={Clock3}
          title="No overtime rule sets yet"
          description="Start from a template (weekly 40, daily 8 + weekly 40, daily 8/12 + seventh day) and adjust it to your contract."
          action={canEdit ? { label: 'New rule set', onClick: () => startNew() } : undefined}
        />
      )}

      {f && (
        <Card className="p-4 sm:p-5">
          <SectionTitle>{f.id ? 'Edit rule set' : 'New rule set'}</SectionTitle>
          {!f.id && (
            <div className="mb-4 max-w-sm">
              <Select label="Start from a template" value="" onChange={(e) => e.target.value && startNew(e.target.value)} helperText="Templates are starting points only — verify them.">
                <option value="">Choose…</option>
                {RULE_SET_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Name" value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} maxLength={200} required />
            <Select label="Workweek starts on" value={f.workweekStartDow} onChange={(e) => setForm({ ...f, workweekStartDow: e.target.value })}>
              {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
            <Input label="Weekly overtime after (hours)" inputMode="decimal" value={f.weeklyOtAfter} onChange={(e) => setForm({ ...f, weeklyOtAfter: e.target.value })} required />
            <Input label="Daily overtime after (hours)" inputMode="decimal" value={f.dailyOtAfter} onChange={(e) => setForm({ ...f, dailyOtAfter: e.target.value })} helperText="Blank = no daily rule" />
            <Input label="Daily double-time after (hours)" inputMode="decimal" value={f.dailyDtAfter} onChange={(e) => setForm({ ...f, dailyDtAfter: e.target.value })} helperText="Blank = none" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Overtime ×" inputMode="decimal" value={f.otMultiplier} onChange={(e) => setForm({ ...f, otMultiplier: e.target.value })} />
              <Input label="Double-time ×" inputMode="decimal" value={f.dtMultiplier} onChange={(e) => setForm({ ...f, dtMultiplier: e.target.value })} />
            </div>
            <Select label="Seventh consecutive day" value={f.seventhDayRule} onChange={(e) => setForm({ ...f, seventhDayRule: e.target.value as SeventhDayRule })}>
              <option value="none">No special rule</option>
              <option value="ot_first_dt_after">Overtime first N hours, then double-time</option>
            </Select>
            <Input label="Seventh-day overtime hours" inputMode="decimal" value={f.seventhDayOtHours} onChange={(e) => setForm({ ...f, seventhDayOtHours: e.target.value })} disabled={f.seventhDayRule === 'none'} />
            <Select label="Fringe on overtime hours" value={f.fringeOvertimeMode} onChange={(e) => setForm({ ...f, fringeOvertimeMode: e.target.value as FringeOvertimeMode })}>
              <option value="straight">Straight-time amount on every hour</option>
              <option value="multiplied">Multiplied with the overtime premium</option>
            </Select>
            <Input label="Saturday ×" inputMode="decimal" value={f.saturdayMultiplier} onChange={(e) => setForm({ ...f, saturdayMultiplier: e.target.value })} helperText="Blank = none" />
            <Input label="Sunday ×" inputMode="decimal" value={f.sundayMultiplier} onChange={(e) => setForm({ ...f, sundayMultiplier: e.target.value })} helperText="Blank = none" />
            <Input label="Holiday ×" inputMode="decimal" value={f.holidayMultiplier} onChange={(e) => setForm({ ...f, holidayMultiplier: e.target.value })} helperText="Blank = none" />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Textarea label="Holidays (one date per line)" rows={3} value={f.holidays} onChange={(e) => setForm({ ...f, holidays: e.target.value })} placeholder={'2027-07-05\n2027-09-06'} />
            <Textarea label="Description" rows={3} value={f.description} onChange={(e) => setForm({ ...f, description: e.target.value })} maxLength={1000} />
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={f.active} onChange={(e) => setForm({ ...f, active: e.target.checked })} className="h-4 w-4 accent-accent" />
            Active (can be assigned to jobs)
          </label>
          {livePreview.length > 0 && (
            <div className="mt-4 rounded-xl bg-bg-primary p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">What this does</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-text-primary">{livePreview.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={submit} disabled={busy}>Save rule set</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {ruleSets.map((r) => (
          <Card key={r.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-text-primary">{r.name}</h3>
                  <ReviewBadge status={r.legalReviewStatus} />
                  {!r.active && <Pill>Inactive</Pill>}
                </div>
                {r.description && <p className="mt-0.5 text-xs text-text-secondary">{r.description}</p>}
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(r)}><Pencil size={14} /> Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}><Trash2 size={14} /> Delete</Button>
                </div>
              )}
            </div>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-text-secondary">
              {describeRuleSet(r).map((l) => <li key={l}>{l}</li>)}
            </ul>
            <div className="mt-3">
              <button type="button" onClick={() => setReviewOpenId(reviewOpenId === r.id ? null : r.id)} className="focus-ring rounded-lg text-xs font-medium text-accent hover:underline" aria-expanded={reviewOpenId === r.id}>
                {reviewOpenId === r.id ? 'Hide legal review' : 'Legal review'}
              </button>
              {reviewOpenId === r.id && (
                <div className="mt-2">
                  <ReviewControl status={r.legalReviewStatus} reviewedBy={r.legalReviewedBy} reviewedAt={r.legalReviewedAt} canEdit={canEdit} busy={busy} onSet={(s, who) => setReview(r.id, s, who)} />
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={!!deleting}
        title="Delete this rule set?"
        description="A rule set that is assigned to a job or used in a payroll cannot be deleted — deactivate it instead."
        confirmLabel="Delete rule set"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
