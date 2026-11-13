import { useState } from 'react';
import { Plus, Truck, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import {
  friendlyLandscapingError,
  listCrews,
  listEquipment,
  listTechnicians,
  listTools,
  listVehicles,
  saveCrew,
  setEquipment,
  useLandscapeLoader,
  type Crew,
} from '@/lib/landscapingApi';
import { PanelState, Section, todayISO } from './ui';

export function CrewsPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const [date, setDate] = useState(todayISO());
  const crews = useLandscapeLoader((o) => listCrews(o), []);
  const techs = useLandscapeLoader((o) => listTechnicians(o), []);
  const vehicles = useLandscapeLoader((o) => listVehicles(o), []);
  const tools = useLandscapeLoader((o) => listTools(o), []);
  const equipment = useLandscapeLoader((o) => listEquipment(o, date), [date]);
  const [form, setForm] = useState<{ id?: string; name: string; lead: string; members: string[]; vehicle: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const list = crews.data ?? [];
  const techName = (id: string | null) => techs.data?.find((t) => t.id === id)?.member_name ?? techs.data?.find((t) => t.id === id)?.member_email ?? '—';
  const crewName = (id: string) => list.find((c) => c.id === id)?.name ?? 'another crew';
  const assigned = equipment.data ?? [];

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await saveCrew(ownerId, { id: form.id, name: form.name, lead_technician_id: form.lead || null, member_ids: form.members, default_vehicle_id: form.vehicle || null });
      setForm(null);
      crews.reload();
      toast('Crew saved', 'success');
    } catch (e) {
      toast(friendlyLandscapingError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleAsset = async (crew: Crew, kind: 'vehicle' | 'tool', id: string, on: boolean) => {
    try {
      await setEquipment(ownerId, crew.id, date, { kind, id }, on);
      equipment.reload();
    } catch (e) {
      const msg = friendlyLandscapingError(e);
      toast(/duplicate|already exists/i.test(msg) ? 'That item is already assigned to another crew on this day.' : msg, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Section title="Crews" description="A crew is a lead plus helpers. Jobs for a crew are assigned to its lead." actions={canManage && <Button size="sm" onClick={() => setForm({ name: '', lead: '', members: [], vehicle: '' })}><Plus className="mr-1 h-4 w-4" />New crew</Button>}>
        {form && (
          <div className="mb-4 space-y-3 rounded-xl border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Crew name" required value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <SelectField label="Lead" value={form.lead} onChange={(x) => setForm({ ...form, lead: x })}>
                <option value="">None</option>
                {(techs.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.member_name ?? t.member_email}</option>)}
              </SelectField>
              <SelectField label="Default vehicle" value={form.vehicle} onChange={(x) => setForm({ ...form, vehicle: x })}>
                <option value="">None</option>
                {(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </SelectField>
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-text-primary">Helpers (max 11)</legend>
              <div className="flex flex-wrap gap-2">
                {(techs.data ?? []).filter((t) => t.id !== form.lead).map((t) => (
                  <label key={t.id} className="flex min-h-[44px] items-center gap-1 rounded-lg border border-border px-2 text-sm">
                    <input type="checkbox" checked={form.members.includes(t.id)} disabled={!form.members.includes(t.id) && form.members.length >= 11} onChange={(e) => setForm({ ...form, members: e.target.checked ? [...form.members, t.id] : form.members.filter((m) => m !== t.id) })} />
                    {t.member_name ?? t.member_email}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
              <Button loading={busy} disabled={!form.name.trim()} onClick={() => void save()}>Save crew</Button>
            </div>
          </div>
        )}
        <PanelState loading={crews.loading} error={crews.error} empty={list.length === 0} emptyTitle="No crews yet" emptyDescription="Create a crew, then give it contracts and equipment." onRetry={crews.reload}>
          <ul className="space-y-2">
            {list.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary p-3 text-sm">
                <span><strong>{c.name}</strong> · lead {techName(c.lead_technician_id)} · {c.member_ids.length} helper(s) {!c.active && <Pill tone="warning">inactive</Pill>}</span>
                {canManage && <span className="flex gap-2"><Button size="xs" variant="secondary" onClick={() => setForm({ id: c.id, name: c.name, lead: c.lead_technician_id ?? '', members: c.member_ids, vehicle: c.default_vehicle_id ?? '' })}>Edit</Button><Button size="xs" variant="ghost" onClick={() => void saveCrew(ownerId, { ...c, active: !c.active }).then(crews.reload, (e) => toast(friendlyLandscapingError(e), 'error'))}>{c.active ? 'Deactivate' : 'Activate'}</Button></span>}
              </li>
            ))}
          </ul>
        </PanelState>
      </Section>

      <Section title="Equipment assignment" description="Assign trucks and tools to a crew for a day. An item can only be on one crew per day.">
        <div className="mb-3 max-w-xs"><Input label="Day" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></div>
        <PanelState loading={equipment.loading || vehicles.loading || tools.loading} error={equipment.error ?? vehicles.error ?? tools.error} empty={list.length === 0} emptyTitle="Create a crew first" onRetry={() => { equipment.reload(); vehicles.reload(); tools.reload(); }}>
          <div className="space-y-3">
            {list.filter((c) => c.active).map((c) => (
              <div key={c.id} className="rounded-xl border border-border p-3">
                <p className="text-sm font-medium text-text-primary">{c.name}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="flex items-center gap-1 text-xs font-medium text-text-secondary"><Truck className="h-3 w-3" aria-hidden="true" />Vehicles</p>
                    {(vehicles.data ?? []).length === 0 ? <p className="text-xs text-text-secondary">No vehicles in Fleet yet.</p> : (vehicles.data ?? []).map((v) => {
                      const a = assigned.find((x) => x.vehicle_id === v.id);
                      return <label key={v.id} className="flex min-h-[40px] items-center gap-2 text-sm"><input type="checkbox" checked={a?.crew_id === c.id} disabled={!canManage || (!!a && a.crew_id !== c.id)} onChange={(e) => void toggleAsset(c, 'vehicle', v.id, e.target.checked)} />{v.label}{a && a.crew_id !== c.id && <Pill tone="warning">on {crewName(a.crew_id)}</Pill>}</label>;
                    })}
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-xs font-medium text-text-secondary"><Wrench className="h-3 w-3" aria-hidden="true" />Tools</p>
                    {(tools.data ?? []).length === 0 ? <p className="text-xs text-text-secondary">No tools in the Tool Crib yet.</p> : (tools.data ?? []).slice(0, 60).map((t) => {
                      const a = assigned.find((x) => x.tool_item_id === t.id);
                      return <label key={t.id} className="flex min-h-[40px] items-center gap-2 text-sm"><input type="checkbox" checked={a?.crew_id === c.id} disabled={!canManage || (!!a && a.crew_id !== c.id)} onChange={(e) => void toggleAsset(c, 'tool', t.id, e.target.checked)} />{t.name} <span className="text-xs text-text-secondary">#{t.tool_number}</span>{a && a.crew_id !== c.id && <Pill tone="warning">on {crewName(a.crew_id)}</Pill>}</label>;
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PanelState>
      </Section>
    </div>
  );
}
