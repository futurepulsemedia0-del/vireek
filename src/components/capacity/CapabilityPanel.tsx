import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { TagToggleGroup } from '@/components/capacity/TagToggleGroup';
import { useToast } from '@/contexts/ToastContext';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS } from '@/lib/laborMarketplace';
import { describeNetworkError } from '@/lib/contractorNetwork';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_KIND_LABELS,
  EQUIPMENT_OPTIONS,
  SKILL_OPTIONS,
  SLA_OPTIONS,
  centsToRateInput,
  isCredentialActive,
  liquidityApi,
  parseRateToCents,
  parseRegionsInput,
  type CapacityCredential,
  type CredentialKind,
} from '@/lib/capacityLiquidity';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

function credentialBadge(c: CapacityCredential): { text: string; cls: string } {
  if (c.status === 'rejected') return { text: 'Rejected', cls: 'bg-danger/10 text-danger' };
  if (!isCredentialActive(c)) return { text: 'Expired', cls: 'bg-danger/10 text-danger' };
  if (c.status === 'verified') return { text: 'Verified', cls: 'bg-success-500/10 text-success-500' };
  return { text: 'Self-declared', cls: 'bg-bg-tertiary text-text-secondary' };
}

/** What the matching engine scores you on beyond trade + load: skills, gear, regions, price, SLA, credentials. */
export function CapabilityPanel() {
  const { toast } = useToast();
  const [skills, setSkills] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [regionsText, setRegionsText] = useState('');
  const [rate, setRate] = useState('');
  const [sla, setSla] = useState('');
  const [saving, setSaving] = useState(false);

  const [credentials, setCredentials] = useState<CapacityCredential[]>([]);
  const [kind, setKind] = useState<CredentialKind>('insurance');
  const [label, setLabel] = useState('');
  const [trade, setTrade] = useState('');
  const [expires, setExpires] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [caps, creds] = await Promise.all([liquidityApi.getCapabilities(), liquidityApi.listCredentials()]);
      if (caps) {
        setSkills(caps.skills);
        setEquipment(caps.equipment);
        setRegionsText(caps.service_regions.join('; '));
        setRate(centsToRateInput(caps.hourly_rate_cents));
        setSla(caps.sla_response_minutes == null ? '' : String(caps.sla_response_minutes));
      }
      setCredentials(creds);
    } catch {
      /* non-fatal: the panel simply stays at its defaults */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const rateCents = parseRateToCents(rate);
    if (rateCents !== null && !Number.isFinite(rateCents)) return toast('Enter a valid hourly rate.', 'error');
    const regions = parseRegionsInput(regionsText);
    if (regions.length > 10) return toast('Add at most 10 extra service regions.', 'error');
    setSaving(true);
    try {
      await liquidityApi.setCapabilities({
        skills,
        equipment,
        serviceRegions: regions,
        hourlyRateCents: rateCents,
        slaResponseMinutes: sla === '' ? null : Number(sla),
      });
      toast('Capabilities saved.', 'success');
      await load();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const addCredential = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (label.trim().length < 2) return toast('Give the credential a name.', 'error');
    if (kind === 'insurance' && (!expires || expires < today)) {
      return toast('Insurance needs a future expiry date.', 'error');
    }
    setAdding(true);
    try {
      await liquidityApi.addCredential({
        kind,
        label: label.trim(),
        trade: trade || null,
        expiresOn: expires || null,
      });
      toast('Credential added. It counts as self-declared until Vireek verifies it.', 'success');
      setLabel('');
      setTrade('');
      setExpires('');
      await load();
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      setAdding(false);
    }
  };

  const removeCredential = async (id: string) => {
    setRemovingId(id);
    try {
      await liquidityApi.removeCredential(id);
    } catch (e) {
      toast(describeNetworkError(e), 'error');
    } finally {
      await load();
      setRemovingId(null);
    }
  };

  return (
    <section className="space-y-5 rounded-xl border border-border bg-bg-secondary p-5" aria-label="Capabilities and credentials">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Capabilities &amp; trust</h2>
      </div>
      <p className="text-sm text-text-secondary">
        Jobs can require specific skills, equipment, insurance, a price ceiling or a response SLA. The more you
        declare (and get verified), the more jobs you qualify for and the higher you rank.
      </p>

      <TagToggleGroup label="Skills" options={SKILL_OPTIONS} value={skills} onChange={setSkills} />
      <TagToggleGroup label="Equipment on your vans" options={EQUIPMENT_OPTIONS} value={equipment} onChange={setEquipment} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Hourly rate ($)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} helperText="Leave empty if you'd rather not state one." />
        <div>
          <label htmlFor="cx-cap-sla" className="mb-1.5 block text-sm font-medium text-text-primary">
            Typical response time
          </label>
          <select id="cx-cap-sla" value={sla} onChange={(e) => setSla(e.target.value)} className={selectClass}>
            <option value="">Not stated</option>
            {SLA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Within {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Textarea
        label="Additional service regions"
        rows={2}
        value={regionsText}
        onChange={(e) => setRegionsText(e.target.value)}
        helperText="Separate with ; — matched against the job's region in addition to your main service area."
      />

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save capabilities
        </Button>
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-semibold text-text-primary">Credentials</p>
        {credentials.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {credentials.map((c) => {
              const badge = credentialBadge(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                  <div>
                    <p className="font-medium text-text-primary">{c.label}</p>
                    <p className="text-xs text-text-secondary">
                      {CREDENTIAL_KIND_LABELS[c.kind]}
                      {c.trade ? ` · ${(TRADE_CATEGORY_LABELS as Record<string, string>)[c.trade] ?? c.trade}` : ''}
                      {c.expires_on ? ` · expires ${c.expires_on}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}>{badge.text}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeCredential(c.id)}
                      disabled={removingId === c.id}
                      aria-label={`Remove ${c.label}`}
                    >
                      {removingId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cx-cred-kind" className="mb-1.5 block text-sm font-medium text-text-primary">
              Type
            </label>
            <select id="cx-cred-kind" value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)} className={selectClass}>
              {CREDENTIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CREDENTIAL_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <Input label="Name" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="General liability $2M" />
          <div>
            <label htmlFor="cx-cred-trade" className="mb-1.5 block text-sm font-medium text-text-primary">
              Trade (optional)
            </label>
            <select id="cx-cred-trade" value={trade} onChange={(e) => setTrade(e.target.value)} className={selectClass}>
              <option value="">Any trade</option>
              {TRADE_CATEGORY_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {TRADE_CATEGORY_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label={kind === 'insurance' ? 'Expires on' : 'Expires on (optional)'}
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={addCredential} disabled={adding}>
            {adding && <Loader2 size={14} className="animate-spin" />}
            Add credential
          </Button>
        </div>
      </div>
    </section>
  );
}
