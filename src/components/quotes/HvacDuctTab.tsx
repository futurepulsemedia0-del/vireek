import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  VELOCITY_LIMITS_FPM,
  type DuctFieldErrors,
  type DuctInputs,
  type DuctResult,
  type DuctRoomInput,
  type DuctSection,
} from '@/lib/hvacSizing';
import { FieldGrid, Group, NumField, StatTile, WarningList } from '@/components/quotes/HvacFields';

interface Props {
  inputs: DuctInputs;
  errors: DuctFieldErrors;
  result: DuctResult | null;
  /** Cooling capacity (Btu/h) the airflow can be based on, from the load or the chosen equipment. */
  suggestedCoolingBtuh: number | null;
  onChange: (next: DuctInputs) => void;
}

const MAX_ROOMS = 40;

function newRoomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `room-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function rectText(s: DuctSection): string {
  return s.rect.length === 0 ? '\u2014' : s.rect.map((r) => `${r.widthIn}×${r.heightIn}`).join(', ');
}

export function HvacDuctTab({ inputs, errors, result, suggestedCoolingBtuh, onChange }: Props) {
  const setNum = (key: 'coolingBtuh' | 'cfmPerTon' | 'availableStaticInWc' | 'componentLossesInWc' | 'trunkLengthFt' | 'returnLengthFt') =>
    (v: number | null) => onChange({ ...inputs, [key]: v ?? Number.NaN });

  const patchRoom = (id: string, patch: Partial<DuctRoomInput>) =>
    onChange({ ...inputs, rooms: inputs.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-6">
      <Group title="Airflow and pressure" hint="Equal-friction method: the friction rate comes from the pressure left after the coil, filter and grilles, spread over the longest path.">
        <FieldGrid>
          <NumField
            label="System airflow override (cfm)"
            value={inputs.totalCfm}
            nullable
            onChange={(v) => onChange({ ...inputs, totalCfm: v })}
            error={errors.totalCfm}
            helper="Leave blank to use capacity × cfm per ton"
          />
          <NumField label="Cooling capacity (Btu/h)" value={inputs.coolingBtuh} onChange={setNum('coolingBtuh')} error={errors.coolingBtuh} />
          <NumField label="Airflow per ton (cfm)" value={inputs.cfmPerTon} onChange={setNum('cfmPerTon')} error={errors.cfmPerTon} helper="350 humid, 400 typical, 450 dry" />
          <NumField label="Available static pressure (in. wc)" value={inputs.availableStaticInWc} onChange={setNum('availableStaticInWc')} error={errors.availableStaticInWc} helper="From the blower table at this airflow" />
          <NumField label="Coil, filter and grille losses (in. wc)" value={inputs.componentLossesInWc} onChange={setNum('componentLossesInWc')} error={errors.componentLossesInWc} />
          <NumField label="Supply trunk length (ft)" value={inputs.trunkLengthFt} onChange={setNum('trunkLengthFt')} error={errors.trunkLengthFt} helper="Include fitting equivalent length" />
          <NumField label="Return path length (ft)" value={inputs.returnLengthFt} onChange={setNum('returnLengthFt')} error={errors.returnLengthFt} helper="Total effective length" />
        </FieldGrid>
        {suggestedCoolingBtuh !== null && suggestedCoolingBtuh !== inputs.coolingBtuh ? (
          <Button size="sm" variant="secondary" type="button" onClick={() => onChange({ ...inputs, coolingBtuh: suggestedCoolingBtuh })}>
            Use {suggestedCoolingBtuh.toLocaleString('en-US')} Btu/h from the load / chosen system
          </Button>
        ) : null}
      </Group>

      <Group title="Rooms" hint="Enter each room's airflow, or its load and the airflow is shared in proportion.">
        {errors.rooms ? <p role="alert" className="text-xs text-danger">{errors.rooms}</p> : null}
        <ul className="space-y-3">
          {inputs.rooms.map((room, idx) => (
            <li key={room.id} className="rounded-xl border border-border bg-bg-primary p-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Input
                  label="Room"
                  value={room.name}
                  maxLength={60}
                  onChange={(e) => patchRoom(room.id, { name: e.target.value })}
                  error={errors[`room_${idx}_name`]}
                />
                <NumField label="Airflow (cfm)" value={room.cfm} nullable onChange={(v) => patchRoom(room.id, { cfm: v })} error={errors[`room_${idx}_flow`]} />
                <NumField label="Or load (Btu/h)" value={room.loadBtuh} nullable onChange={(v) => patchRoom(room.id, { loadBtuh: v })} />
                <NumField label="Run length (ft)" value={room.runLengthFt} onChange={(v) => patchRoom(room.id, { runLengthFt: v ?? Number.NaN })} error={errors[`room_${idx}_run`]} />
              </div>
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="ghost" type="button" onClick={() => onChange({ ...inputs, rooms: inputs.rooms.filter((r) => r.id !== room.id) })} aria-label={`Remove ${room.name || 'room'}`}>
                  <Trash2 size={14} aria-hidden="true" /> Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={inputs.rooms.length >= MAX_ROOMS}
          onClick={() => onChange({ ...inputs, rooms: [...inputs.rooms, { id: newRoomId(), name: '', cfm: null, loadBtuh: null, runLengthFt: 25 }] })}
        >
          <Plus size={14} aria-hidden="true" /> Add room
        </Button>
      </Group>

      <DuctResultView result={result} />
    </div>
  );
}

function DuctResultView({ result }: { result: DuctResult | null }) {
  if (!result) {
    return (
      <div role="status" className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
        Add at least one room and fix any highlighted fields to see duct sizes.
      </div>
    );
  }
  return (
    <section aria-label="Duct results" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="System airflow" value={`${result.totalCfm.toLocaleString('en-US')} cfm`} />
        <StatTile label="Friction rate" value={`${result.systemFrictionRate.toFixed(3)}`} hint="in. wc per 100 ft" />
        <StatTile label="Supply trunk" value={`${result.supplyTrunk.roundSizeIn}\u2033 round`} hint={`${result.supplyTrunk.velocityFpm} fpm`} />
        <StatTile label="Return trunk" value={`${result.returnTrunk.roundSizeIn}\u2033 round`} hint={`${result.returnTrunk.velocityFpm} fpm`} />
      </div>
      <WarningList items={result.warnings} />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Duct sizes</caption>
          <thead className="bg-bg-tertiary text-left text-xs text-text-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Run</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">cfm</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Round</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Velocity</th>
              <th scope="col" className="px-3 py-2 font-medium">Rectangular (W×H in.)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <Row name="Supply trunk" s={result.supplyTrunk} limit={VELOCITY_LIMITS_FPM.trunk} />
            <Row name="Return trunk" s={result.returnTrunk} limit={VELOCITY_LIMITS_FPM.return} />
            {result.branches.map((b) => (
              <Row key={b.id} name={b.name || 'Room'} s={b} limit={VELOCITY_LIMITS_FPM.branch} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-secondary">
        Round sizes are rounded up to the next standard size. Rectangular sizes have the same friction as the round duct
        (aspect ratio up to 4:1). Confirm with the manufacturer&apos;s blower table and your fitting losses before building.
      </p>
    </section>
  );
}

function Row({ name, s, limit }: { name: string; s: DuctSection; limit: number }) {
  const hot = s.velocityFpm > limit + 50;
  return (
    <tr>
      <th scope="row" className="px-3 py-2 text-left font-normal text-text-primary">{name}</th>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{s.cfm.toLocaleString('en-US')}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text-primary">{s.roundSizeIn}&Prime;</td>
      <td className={`px-3 py-2 text-right tabular-nums ${hot ? 'text-danger' : 'text-text-primary'}`}>{s.velocityFpm} fpm</td>
      <td className="px-3 py-2 text-text-secondary">{rectText(s)}</td>
    </tr>
  );
}
