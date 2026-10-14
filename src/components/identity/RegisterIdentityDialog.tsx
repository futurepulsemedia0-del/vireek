import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { registerIdentity } from '@/lib/universalIdentityApi';
import { ENTITY_TYPES, ENTITY_TYPE_META, identityErrorMessage, parseAttributesInput, type EntityType } from '@/lib/universalIdentity';

const FIELD = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';

export function RegisterIdentityDialog({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: (entityId: string) => void;
}) {
  const { toast } = useToast();
  const [type, setType] = useState<EntityType>('person');
  const [name, setName] = useState('');
  const [attrs, setAttrs] = useState('');
  const [refSystem, setRefSystem] = useState('');
  const [refType, setRefType] = useState('');
  const [refValue, setRefValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseAttributesInput(attrs);
    if ('error' in parsed) return setError(parsed.error);
    const hasRef = refSystem.trim() || refType.trim() || refValue.trim();
    if (hasRef && !(refSystem.trim() && refType.trim() && refValue.trim())) return setError('Fill all three reference fields, or none.');
    setBusy(true);
    try {
      const r = await registerIdentity({
        type, name, attributes: parsed.value,
        refs: hasRef ? [{ system: refSystem.trim().toLowerCase(), ref_type: refType.trim().toLowerCase(), ref_value: refValue.trim() }] : [],
        source: { source_type: 'user_entry', method: 'dashboard' },
      });
      toast(r.created ? `Registered ${r.uid}` : `Already registered as ${r.uid}`, r.created ? 'success' : 'info');
      onRegistered(r.entityId);
      setName(''); setAttrs(''); setRefSystem(''); setRefType(''); setRefValue('');
      onClose();
    } catch (err) {
      setError(identityErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="reg-title" className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-5 shadow-xl">
        <h2 id="reg-title" className="text-lg font-bold text-text-primary">Register an identity</h2>
        <p className="text-xs text-text-secondary">
          Creates a permanent universal ID. If the external reference below is already registered in your account, the existing identity is returned instead of a duplicate.
        </p>
        <div>
          <label htmlFor="reg-type" className="mb-1 block text-xs font-medium text-text-secondary">Type</label>
          <select id="reg-type" value={type} onChange={(e) => setType(e.target.value as EntityType)} className={FIELD}>
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{ENTITY_TYPE_META[t].label} — {ENTITY_TYPE_META[t].hint}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="reg-name" className="mb-1 block text-xs font-medium text-text-secondary">Name</label>
          <input id="reg-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder="e.g. Carrier 24ACC636A003" />
        </div>
        <div>
          <label htmlFor="reg-attrs" className="mb-1 block text-xs font-medium text-text-secondary">Attributes (optional JSON)</label>
          <textarea id="reg-attrs" rows={3} value={attrs} onChange={(e) => setAttrs(e.target.value)} className={`${FIELD} font-mono text-xs`} placeholder='{"serial": "A123"}' />
        </div>
        <fieldset className="grid grid-cols-3 gap-2">
          <legend className="mb-1 text-xs font-medium text-text-secondary">External reference (optional)</legend>
          <input aria-label="Reference system" value={refSystem} onChange={(e) => setRefSystem(e.target.value)} className={FIELD} placeholder="system" />
          <input aria-label="Reference type" value={refType} onChange={(e) => setRefType(e.target.value)} className={FIELD} placeholder="type" />
          <input aria-label="Reference value" value={refValue} onChange={(e) => setRefValue(e.target.value)} className={FIELD} placeholder="value" />
        </fieldset>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>{busy ? 'Registering…' : 'Register'}</Button>
        </div>
      </form>
    </div>
  );
}
