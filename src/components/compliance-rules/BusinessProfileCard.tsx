/**
 * Business profile for the compliance engine: home state + contractor licenses.
 * The state decides which rule packs apply to the business; licenses are what
 * the license-display rules check on quotes and contracts.
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { US_STATE_OPTIONS, type ComplianceProfile, type LicenseEntry } from '@/lib/complianceRules';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

interface Props {
  profile: ComplianceProfile | null;
  canEdit: boolean;
  saving: boolean;
  onSave: (state: string | null, licenses: LicenseEntry[]) => Promise<void>;
}

const MAX_LICENSES = 20;
const blank = (): LicenseEntry => ({ state: '', number: '', trade: '', expiresOn: '' });

export function BusinessProfileCard({ profile, canEdit, saving, onSave }: Props) {
  const [state, setState] = useState('');
  const [licenses, setLicenses] = useState<LicenseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(profile?.business_state ?? '');
    setLicenses((profile?.licenses ?? []).map((l) => ({ ...l, trade: l.trade ?? '', expiresOn: l.expiresOn ?? '' })));
  }, [profile]);

  const update = (i: number, patch: Partial<LicenseEntry>) =>
    setLicenses((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setError(null);
    for (const l of licenses) {
      if (!l.state || !l.number.trim()) return setError('Each license needs a state and a license number.');
      if (l.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(l.expiresOn)) return setError('Expiry dates must look like 2027-05-31.');
    }
    await onSave(
      state || null,
      licenses.map((l) => ({
        state: l.state, number: l.number.trim(),
        ...(l.trade?.trim() ? { trade: l.trade.trim() } : {}),
        ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}),
      })),
    );
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="bp-title">
      <h2 id="bp-title" className="text-lg font-semibold text-text-primary">Business profile</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Your home state decides which rules apply to your business. Add every contractor license you hold so Vireek can check
        it appears on quotes and contracts.
      </p>

      <div className="mt-4 max-w-xs">
        <label htmlFor="bp-state" className="mb-1.5 block text-sm font-medium text-text-primary">Home state</label>
        <select id="bp-state" className={selectClass} value={state} disabled={!canEdit || saving} onChange={(e) => setState(e.target.value)}>
          <option value="">Not set</option>
          {US_STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-text-primary">Contractor licenses</h3>
      {licenses.length === 0 && <p className="mt-1 text-sm text-text-secondary">Add a license so Vireek can check it appears on your quotes and contracts.</p>}
      <ul className="mt-2 space-y-3">
        {licenses.map((l, i) => (
          <li key={i} className="grid gap-3 rounded-xl border border-border bg-bg-primary p-3 sm:grid-cols-[9rem_1fr_1fr_10rem_auto] sm:items-end">
            <div>
              <label htmlFor={`lic-state-${i}`} className="mb-1.5 block text-sm font-medium text-text-primary">State</label>
              <select id={`lic-state-${i}`} className={selectClass} value={l.state} disabled={!canEdit || saving} onChange={(e) => update(i, { state: e.target.value })}>
                <option value="">Select</option>
                {US_STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
              </select>
            </div>
            <Input label="License number" value={l.number} maxLength={40} disabled={!canEdit || saving} onChange={(e) => update(i, { number: e.target.value })} />
            <Input label="Trade (optional)" value={l.trade ?? ''} maxLength={60} disabled={!canEdit || saving} onChange={(e) => update(i, { trade: e.target.value })} />
            <Input label="Expires" type="date" value={l.expiresOn ?? ''} disabled={!canEdit || saving} onChange={(e) => update(i, { expiresOn: e.target.value })} />
            {canEdit && (
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove license ${i + 1}`} disabled={saving} onClick={() => setLicenses((ls) => ls.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </li>
        ))}
      </ul>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={saving || licenses.length >= MAX_LICENSES} onClick={() => setLicenses((ls) => [...ls, blank()])}>
            <Plus className="h-4 w-4" aria-hidden /> Add license
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={submit}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save profile
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-text-secondary">Only the owner or a team member with business-profile access can edit this.</p>
      )}
    </section>
  );
}
