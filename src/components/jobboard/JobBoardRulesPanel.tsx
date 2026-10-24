import { useState } from 'react';
import { AlertTriangle, Loader2, Scale } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyStateInline } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { jobBoardApi } from '@/lib/jobBoardApi';
import {
  describeJobBoardError,
  fairnessSpread,
  validateSettings,
  type FairnessRow,
  type JobBoardSettings,
  type JobBoardVendor,
} from '@/lib/jobBoard';

type NumKey =
  | 'default_expiry_minutes'
  | 'first_look_minutes'
  | 'first_look_size'
  | 'internal_first_minutes'
  | 'fairness_window_days'
  | 'max_active_bids_per_technician';
type BoolKey =
  | 'require_skill_match'
  | 'require_zone_match'
  | 'respect_time_off'
  | 'block_schedule_conflicts'
  | 'allow_subcontractors'
  | 'require_sub_documents';

const NUMBER_FIELDS: Array<{ key: NumKey; label: string; help: string }> = [
  { key: 'default_expiry_minutes', label: 'Default expiry (minutes)', help: 'How long a post stays open (never past the job start).' },
  { key: 'first_look_minutes', label: 'Head-start window (minutes)', help: '0 turns the rotation head start off.' },
  { key: 'first_look_size', label: 'Head-start group size', help: 'How many technicians get the first look.' },
  { key: 'internal_first_minutes', label: 'Technicians-first window (minutes)', help: 'Subcontractors see the post after this delay.' },
  { key: 'fairness_window_days', label: 'Fairness window (days)', help: 'Rolling period used to count recent awards.' },
  { key: 'max_active_bids_per_technician', label: 'Pending requests per technician', help: 'Caps how many shifts one person can hold requests on.' },
];

const BOOL_FIELDS: Array<{ key: BoolKey; label: string; help: string }> = [
  { key: 'require_skill_match', label: 'Require skill match', help: 'Only people with the required skill can claim.' },
  { key: 'require_zone_match', label: 'Require zone match', help: 'Only people assigned to the zone can claim.' },
  { key: 'respect_time_off', label: 'Respect time off & working days', help: 'Hide shifts on approved PTO or non-working days.' },
  { key: 'block_schedule_conflicts', label: 'Block schedule conflicts', help: 'No overlapping jobs, and the daily job limit applies.' },
  { key: 'allow_subcontractors', label: 'Allow subcontractors', help: 'Master switch for subcontractor offers.' },
  { key: 'require_sub_documents', label: 'Require compliant documents', help: 'Subcontractors must hold every required, verified, unexpired document.' },
];

interface Props {
  settings: JobBoardSettings;
  vendors: JobBoardVendor[];
  areas: Array<{ id: string; name: string }>;
  fairness: FairnessRow[];
  onSaved: () => void | Promise<void>;
}

export function JobBoardRulesPanel({ settings, vendors, areas, fairness, onSaved }: Props) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<JobBoardSettings>(settings);
  const [saving, setSaving] = useState(false);
  const spread = fairnessSpread(fairness);

  const save = async () => {
    const problem = validateSettings(draft);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    setSaving(true);
    try {
      await jobBoardApi.saveSettings(draft);
      toast('Board rules saved', 'success');
      await onSaved();
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Claim rules">
        <h2 className="text-sm font-semibold text-text-primary">Claim rules & windows</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <Input
              key={f.key}
              label={f.label}
              helperText={f.help}
              inputMode="numeric"
              value={Number.isNaN(draft[f.key]) ? '' : String(draft[f.key])}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) }))}
            />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {BOOL_FIELDS.map((f) => (
            <label key={f.key} className="flex items-start gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))}
              />
              <span>
                {f.label}
                <span className="block text-xs text-text-secondary">{f.help}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save rules
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Fairness ledger">
        <div className="flex items-center gap-2">
          <Scale size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Fairness ledger — last {settings.fairness_window_days} days</h2>
        </div>
        {fairness.length === 0 ? (
          <EmptyStateInline text="Active technicians appear here once they exist." />
        ) : (
          <>
            {spread.unbalanced && (
              <p className="flex items-center gap-1.5 text-xs text-warning-500">
                <AlertTriangle size={12} /> Shifts are unevenly spread ({spread.min}–{spread.max}). The rotation will favour technicians with fewer awards.
              </p>
            )}
            <ul className="divide-y divide-border text-sm">
              {fairness.map((f) => (
                <li key={f.technician_id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{f.name}</span>
                  <span className="text-text-secondary">{f.awards} awarded</span>
                  <span className="text-xs text-text-secondary">
                    {f.last_awarded_at ? `last ${new Date(f.last_awarded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'never'}
                  </span>
                  <span className="text-xs text-text-secondary">{f.open_offers} open</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-3" aria-label="Subcontractors">
        <h2 className="text-sm font-semibold text-text-primary">Approved subcontractors</h2>
        <p className="text-xs text-text-secondary">
          Only vendors in the Strategic, Preferred or Approved tiers can be enrolled. Manage vendors, tiers and compliance documents in Vendor Management.
        </p>
        {vendors.length === 0 ? (
          <EmptyStateInline text="Add an approved vendor in Vendor Management to enrol subcontractors." />
        ) : (
          vendors.map((v) => <VendorRow key={v.id} vendor={v} areas={areas} onSaved={onSaved} />)
        )}
      </section>
    </div>
  );
}

function VendorRow({
  vendor,
  areas,
  onSaved,
}: {
  vendor: JobBoardVendor;
  areas: Array<{ id: string; name: string }>;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(vendor.enabled);
  const [skills, setSkills] = useState(vendor.skills.join(', '));
  const [areaIds, setAreaIds] = useState<string[]>(vendor.area_ids);
  const [notes, setNotes] = useState(vendor.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const list = skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await jobBoardApi.saveVendorProfile(vendor.id, enabled, list, areaIds, notes.trim());
      toast(`${vendor.name} saved`, 'success');
      await onSaved();
    } catch (e) {
      toast(describeJobBoardError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{vendor.name}</h3>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-secondary">{vendor.tier}</span>
        {!vendor.docs_ok && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">
            <AlertTriangle size={12} /> Documents missing or expired
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          On the board
        </label>
      </div>
      <Input
        label="Skills (comma separated)"
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
        placeholder="hvac, plumbing"
      />
      {areas.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text-primary">Zones covered</legend>
          <div className="flex flex-wrap gap-3">
            {areas.map((a) => (
              <label key={a.id} className="flex items-center gap-1.5 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={areaIds.includes(a.id)}
                  onChange={(e) => setAreaIds((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))}
                />
                {a.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
