import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Clock, Loader2, Plus, ShieldCheck, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { createOverride, fetchOverrides, formatPhone, revokeOverride, type ActiveOverride } from '@/lib/callBlocklist';

const SELECT_CLASS = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';
const DURATIONS: [number, string][] = [[1, '1 hour'], [4, '4 hours'], [24, '24 hours'], [72, '3 days'], [168, '7 days']];
const USES = [1, 2, 3, 5];

function timeLeft(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : h >= 1 ? `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m left` : `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

interface OverridesPanelProps {
  ownerId: string;
  userId: string;
  refreshKey: number;
  onChanged: () => void;
}

export function OverridesPanel({ ownerId, userId, refreshKey, onChanged }: OverridesPanelProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<ActiveOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [phone, setPhone] = useState('');
  const [hours, setHours] = useState(24);
  const [uses, setUses] = useState(1);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setItems(await fetchOverrides(ownerId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const handleCreate = async () => {
    setFormError('');
    setSaving(true);
    try {
      await createOverride(ownerId, userId, { phone, hours, uses, note });
      setPhone('');
      setNote('');
      toast('Override created. The next call from that number will get through.', 'success');
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create the override.');
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeOverride(ownerId, id);
      setItems((prev) => prev.filter((o) => o.id !== id));
      onChanged();
    } catch {
      toast('Could not revoke that override.', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5 hover:translate-y-0">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Let a blocked number through</h2>
          <p className="text-xs text-text-secondary">An override beats the blocklist and every rule — but only for the time and number of calls you choose, then it expires on its own.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Phone number" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(512) 555-0123" error={formError || undefined} />
          <Input label="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Supplier calling back" />
          <div>
            <label htmlFor="ovr-hours" className="mb-1 block text-xs font-medium text-text-secondary">Valid for</label>
            <select id="ovr-hours" className={SELECT_CLASS} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {DURATIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ovr-uses" className="mb-1 block text-xs font-medium text-text-secondary">Calls allowed</label>
            <select id="ovr-uses" className={SELECT_CLASS} value={uses} onChange={(e) => setUses(Number(e.target.value))}>
              {USES.map((u) => (
                <option key={u} value={u}>{u === 1 ? '1 call' : `${u} calls`}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void handleCreate()} disabled={!phone.trim() || saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create override
          </Button>
        </div>
      </Card>

      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Active overrides</h2>
        {loading ? (
          <Card className="space-y-2 p-4 hover:translate-y-0" aria-busy="true"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-24" /></Card>
        ) : error ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load overrides" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
        ) : items.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No active overrides" description="Created overrides appear here until they expire or are used up." />
        ) : (
          <ul className="space-y-2">
            {items.map((o) => (
              <li key={o.id}>
                <Card className="flex items-center gap-3 p-4 hover:translate-y-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success-500/10 text-success-500"><ShieldCheck size={16} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm font-semibold text-text-primary">{formatPhone(o.phone)}</p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
                      <span className="inline-flex items-center gap-1"><Clock size={12} /> {timeLeft(o.expiresAt)}</span>
                      <span>{o.usesRemaining} call{o.usesRemaining === 1 ? '' : 's'} left</span>
                      {o.note && <span className="truncate">· {o.note}</span>}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void handleRevoke(o.id)} aria-label={`Revoke override for ${formatPhone(o.phone)}`}><X size={14} /> Revoke</Button>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
