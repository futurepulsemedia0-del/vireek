/**
 * Equipment Passport detail — /dashboard/equipment-passports/:code
 *
 *  - verified servicer  -> full history, label tools, add to history, sharing
 *  - everyone else      -> public view + "attach to my customer" (proves physical access via the code)
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, Plus } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EquipmentPassportView } from '@/components/passport/EquipmentPassportView';
import { EquipmentPassportLabel } from '@/components/passport/EquipmentPassportLabel';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  addPassportEvent,
  adoptPassport,
  claimPassport,
  equipmentTitle,
  fetchPassport,
  isValidPassportCode,
  normalizePassportCode,
  passportErrorMessage,
  setPassportSharing,
  type ManualEventType,
  type PassportData,
} from '@/lib/equipmentPassport';

const EVENT_TYPES: { value: ManualEventType; label: string }[] = [
  { value: 'inspection', label: 'Inspection' },
  { value: 'repair', label: 'Repair' },
  { value: 'part_replaced', label: 'Part replaced' },
  { value: 'note', label: 'Note' },
  { value: 'decommissioned', label: 'Decommissioned / removed' },
];

const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

interface CustomerOption { id: string; name: string }
interface EquipmentOption { id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null }

// ─── Attach this machine to one of my customers ────────────────────────────────────────────────
function AttachPanel({ code, onDone }: { code: string; onDone: (data: PassportData | null) => void }) {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [equipmentId, setEquipmentId] = useState('new');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('customers').select('id, name').order('name').limit(500)
      .then(({ data }) => setCustomers((data as CustomerOption[]) ?? []));
  }, []);

  useEffect(() => {
    setEquipmentId('new');
    if (!customerId) { setEquipment([]); return; }
    supabase.from('equipment').select('id, equipment_type, make, model, serial_number').eq('customer_id', customerId).eq('status', 'active')
      .then(({ data }) => setEquipment((data as EquipmentOption[]) ?? []));
  }, [customerId]);

  const submit = async () => {
    if (!customerId) { toast('Choose a customer first', 'error'); return; }
    setBusy(true);
    try {
      if (equipmentId === 'new') {
        await adoptPassport(code, customerId);
        toast('Machine added to this customer and linked to its passport', 'success');
        onDone(null);
      } else {
        const data = await claimPassport(code, equipmentId);
        toast('Verified — you can now see and add to this machine’s history', 'success');
        onDone(data);
      }
    } catch (err) {
      toast(passportErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark" aria-labelledby="attach-title">
      <h2 id="attach-title" className="text-sm font-semibold text-text-primary">Service this machine</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        Scanning the label proves you are on site. Attach the machine to a customer to unlock its full history and add your own visits.
      </p>
      <div className="mt-3 space-y-2.5">
        <div>
          <label htmlFor="attach-customer" className="mb-1 block text-xs font-medium text-text-secondary">Customer</label>
          <select id="attach-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={field}>
            <option value="">Select a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {customerId && (
          <div>
            <label htmlFor="attach-equipment" className="mb-1 block text-xs font-medium text-text-secondary">Equipment record</label>
            <select id="attach-equipment" value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className={field}>
              <option value="new">Create a new record from this passport</option>
              {equipment.map((e) => (
                <option key={e.id} value={e.id}>
                  {[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}{e.serial_number ? ` · ${e.serial_number}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="button" onClick={submit} disabled={busy || !customerId} className="focus-ring w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {busy ? 'Working…' : 'Attach to customer'}
        </button>
      </div>
    </section>
  );
}

// ─── Contribute to the history ──────────────────────────────────────────────────────────────────
function AddEventPanel({ code, onAdded }: { code: string; onAdded: () => void }) {
  const { toast } = useToast();
  const [type, setType] = useState<ManualEventType>('inspection');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [date, setDate] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const submit = async () => {
    if (!title.trim()) { toast('Add a short title', 'error'); return; }
    setBusy(true);
    try {
      await addPassportEvent({ code, type, title, detail, occurredAt: date || undefined, isPublic });
      setTitle(''); setDetail(''); setDate(''); setIsPublic(false);
      toast('Added to the passport history', 'success');
      onAdded();
    } catch (err) {
      toast(passportErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark" aria-labelledby="add-event-title">
      <h2 id="add-event-title" className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Plus size={15} className="text-accent" aria-hidden="true" /> Add to history</h2>
      <div className="space-y-2.5">
        <select aria-label="Entry type" value={type} onChange={(e) => setType(e.target.value as ManualEventType)} className={field}>
          {EVENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Annual inspection — all readings normal" className={field} />
        <textarea aria-label="Details" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} rows={3} placeholder="Details (visible to verified servicing companies only)" className={field} />
        <input aria-label="Date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} className={field} />
        <label className="flex items-start gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="mt-0.5" />
          Show the title on the public passport (never put names or addresses in it)
        </label>
        <button type="button" onClick={submit} disabled={busy} className="focus-ring w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {busy ? 'Saving…' : 'Add entry'}
        </button>
        <p className="text-[11px] text-text-secondary">Entries are permanent. A mistake is corrected with a new entry, never by editing.</p>
      </div>
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────────────────────────
export function EquipmentPassportDetailPage() {
  const { code: rawCode = '' } = useParams<{ code: string }>();
  const code = normalizePassportCode(rawCode);
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<PassportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    if (!isValidPassportCode(code)) { setData({ found: false }); setLoading(false); return; }
    setFailed(false);
    try {
      setData(await fetchPassport(code));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [code, user]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const toggleSharing = async () => {
    if (!data?.link) return;
    const next = !data.link.show_contractor_publicly;
    try {
      await setPassportSharing(code, next);
      setData({ ...data, link: { ...data.link, show_contractor_publicly: next } });
      toast(next ? 'Your company name is now shown on the public passport' : 'Your company name is now hidden on the public passport', 'success');
    } catch (err) {
      toast(passportErrorMessage(err), 'error');
    }
  };

  const member = data?.access === 'member';

  return (
    <DashboardLayout activeLabel="Equipment Passports">
      <Link to="/dashboard/equipment-passports" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft size={13} aria-hidden="true" /> All passports
      </Link>

      {loading && <div className="h-80 animate-pulse rounded-2xl bg-bg-secondary" aria-busy="true" />}

      {!loading && (failed || (data && !data.found)) && (
        <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
          <p className="text-sm font-semibold text-text-primary">{failed ? 'Could not load this passport' : 'Passport not found'}</p>
          <p className="mt-1 text-sm text-text-secondary">{failed ? 'Please try again in a moment.' : 'Check the code on the machine label.'}</p>
        </div>
      )}

      {!loading && data?.found && data.passport && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            {!member && (
              <div className="mb-4 rounded-xl bg-warning-500/10 px-4 py-3 text-xs text-warning-500" role="status">
                You are viewing the public passport of {equipmentTitle(data.passport)}. Attach it to a customer to unlock the full history.
              </div>
            )}
            <EquipmentPassportView data={data} />
          </div>

          <div className="space-y-4">
            {member ? (
              <>
                <EquipmentPassportLabel passport={data.passport} />
                <AddEventPanel code={code} onAdded={() => void load()} />
                {data.link && (
                  <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
                    <h2 className="text-sm font-semibold text-text-primary">Your company on the public passport</h2>
                    <p className="mt-0.5 text-xs text-text-secondary">Showing your name turns every scan of this machine into a verified reference for your work.</p>
                    <button type="button" onClick={toggleSharing} className="focus-ring mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
                      {data.link.show_contractor_publicly ? <><EyeOff size={13} aria-hidden="true" /> Hide my company name</> : <><Eye size={13} aria-hidden="true" /> Show my company name</>}
                    </button>
                  </section>
                )}
              </>
            ) : (
              <AttachPanel code={code} onDone={(d) => { if (d) setData(d); else void load(); }} />
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
