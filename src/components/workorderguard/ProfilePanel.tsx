import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { BREAKDOWN_KEYS, SERVICECHANNEL_DEFAULTS, isValidTimezone, validateRules, type BreakdownKey, type PortalRules } from '@/lib/workOrderGuard';
import { deleteProfile, saveProfile, type PortalProfile } from '@/lib/workOrderGuardApi';

type NumKey = { [K in keyof PortalRules]: PortalRules[K] extends number ? K : never }[keyof PortalRules];
type BoolKey = { [K in keyof PortalRules]: PortalRules[K] extends boolean ? K : never }[keyof PortalRules];

const NUMS: [NumKey, string, string][] = [
  ['acceptWindowMinutes', 'Accept / decline window (minutes)', '30 in the guidelines'],
  ['acceptWindowEmergencyMinutes', 'Emergency window (minutes)', '15 in the guidelines'],
  ['acceptWarnMinutes', 'Warn this many minutes before it closes', ''],
  ['checkInRadiusMiles', 'Check-in radius (miles)', '0.25 = ¼ mile'],
  ['invoiceWithinDays', 'Invoice within (days of completion)', '10 in the guidelines'],
  ['ineligibleAfterDays', 'Work order ineligible after (days)', '90 in the guidelines'],
  ['deadlineWarnDays', 'Warn this many days before a deadline', ''],
  ['breakdownToleranceCents', 'Allowed total vs parts gap (cents)', '0 = must match exactly'],
  ['paymentTermsDays', 'Typical days from approval to deposit', 'Only used to rank deposit matches'],
];
const BOOLS: [BoolKey, string][] = [
  ['checkInAfterProposalApproval', 'Check-in only after proposal approval'],
  ['oneInvoicePerWorkOrder', 'One invoice per work order'],
  ['invoiceMayNotExceedNte', 'Invoice may not exceed NTE (unless a proposal is approved)'],
  ['allowSalesTax', 'Allow sales tax on invoices'],
  ['allowManagementFee', 'Allow a management-fee line'],
];

export function ProfilePanel({ profile, onSaved, onDeleted, canDelete }: { profile: PortalProfile; onSaved: (p: PortalProfile) => void; onDeleted: () => void; canDelete: boolean }) {
  const { toast } = useToast();
  const [name, setName] = useState(profile.name);
  const [payer, setPayer] = useState(profile.payerName ?? '');
  const [tz, setTz] = useState(profile.timezone);
  const [rules, setRules] = useState<PortalRules>(profile.rules);
  const [priorities, setPriorities] = useState(profile.rules.emergencyPriorities.join(', '));
  const [busy, setBusy] = useState(false);

  const effective: PortalRules = { ...rules, emergencyPriorities: priorities.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) };
  const problems = [...validateRules(effective), ...(name.trim() ? [] : ['Give the profile a name.']), ...(isValidTimezone(tz) ? [] : ['Timezone must be an IANA name such as America/Chicago.'])];

  const save = async () => {
    if (problems.length > 0 || busy) return;
    setBusy(true);
    try { onSaved(await saveProfile({ id: profile.id, name: name.trim(), payerName: payer.trim(), timezone: tz.trim(), rules: effective, makeDefault: profile.isDefault })); toast('Profile saved.', 'success'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy || !window.confirm(`Delete "${profile.name}" and all of its imported work orders? This cannot be undone.`)) return;
    setBusy(true);
    try { await deleteProfile(profile.id); toast('Profile deleted.', 'success'); onDeleted(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete.', 'error'); setBusy(false); }
  };
  const toggleKey = (k: BreakdownKey) => setRules({ ...rules, requiredBreakdown: BREAKDOWN_KEYS.filter((x) => (x === k ? !rules.requiredBreakdown.includes(k) : rules.requiredBreakdown.includes(x))) });

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-secondary">Starting values come from ServiceChannel's Jan 2025 Trade Partner Guidelines. Check them against your current portal agreement — every value below is yours to change.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Profile name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Input label="Payer name on bank deposits" value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={120} helperText="Helps match deposits" />
        <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} helperText="Portal timestamps and day counts use this" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NUMS.map(([k, label, hint]) => (
          <Input key={k} label={label} type="number" inputMode="decimal" step="any" value={Number.isNaN(rules[k]) ? "" : String(rules[k])} helperText={hint || undefined}
            onChange={(e) => setRules({ ...rules, [k]: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
        ))}
      </div>
      <Input label="Emergency priority labels (comma separated)" value={priorities} onChange={(e) => setPriorities(e.target.value)} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Rules</legend>
        {BOOLS.map(([k, label]) => (
          <label key={k} className="flex min-h-[40px] items-center gap-3 text-sm text-text-primary"><input type="checkbox" checked={rules[k]} onChange={(e) => setRules({ ...rules, [k]: e.target.checked })} /> {label}</label>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Invoice must break out</legend>
        <div className="flex flex-wrap gap-4">
          {BREAKDOWN_KEYS.map((k) => <label key={k} className="flex min-h-[40px] items-center gap-2 text-sm capitalize text-text-primary"><input type="checkbox" checked={rules.requiredBreakdown.includes(k)} onChange={() => toggleKey(k)} /> {k}</label>)}
        </div>
      </fieldset>
      {problems.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-red-500">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void save()} disabled={busy || problems.length > 0}>{busy ? 'Saving…' : 'Save rules'}</Button>
        <Button variant="secondary" onClick={() => { setRules(SERVICECHANNEL_DEFAULTS); setPriorities(SERVICECHANNEL_DEFAULTS.emergencyPriorities.join(', ')); }} disabled={busy}>Reset to ServiceChannel defaults</Button>
        {canDelete && <Button variant="ghost" onClick={() => void remove()} disabled={busy}>Delete profile</Button>}
      </div>
    </div>
  );
}
