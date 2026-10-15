import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  MapPinned,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  X,
  Star,
  Zap,
  Users,
  Hash,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Search,
  PhoneCall,
  CheckCircle2,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { supabase, TeamMember } from '@/lib/supabase';
import { geocodeTargets } from '@/lib/routing';
import {
  AREA_COLORS,
  DEFAULT_OUT_OF_AREA_MESSAGES,
  MAX_SURGE,
  MIN_SURGE,
  computeAreaQuote,
  deleteServiceArea,
  extractPostalCode,
  fetchServiceAreaBundle,
  findZipOverlaps,
  formatCents,
  isSurgeActive,
  outOfAreaReply,
  parsePolygonInput,
  parsePostalCodeList,
  polygonToText,
  resolveServiceArea,
  saveServiceArea,
  saveServiceAreaSettings,
  setServiceAreaActive,
  validateAreaInput,
  type AreaTechnician,
  type LatLng,
  type OutOfAreaMode,
  type ServiceArea,
  type ServiceAreaInput,
  type ServiceAreaSettings,
  type ZoneType,
} from '@/lib/serviceAreas';

type Technician = Pick<TeamMember, 'id' | 'member_name' | 'member_email'>;

const MODE_LABELS: Record<OutOfAreaMode, { title: string; hint: string }> = {
  decline: {
    title: 'Politely decline',
    hint: 'Tell the caller we do not serve their address and end the booking.',
  },
  waitlist: {
    title: 'Offer the waitlist',
    hint: 'Take their name and number so you can reach out if you expand.',
  },
  transfer: {
    title: 'Transfer to a person',
    hint: 'Hand the call to your team to decide on an exception.',
  },
};

const techLabel = (t: Technician) => t.member_name?.trim() || t.member_email;

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// SMALL PIECES
// ============================================================

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-bg-tertiary'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Hash;
  label: string;
  value: string | number;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="text-xl font-bold text-text-primary">{value}</p>
        </div>
      </div>
    </Card>
  );
}

/** Tiny SVG outline so a pasted polygon can be eyeballed before saving. */
function PolygonPreview({ polygon, color }: { polygon: LatLng[]; color: string }) {
  const points = useMemo(() => {
    const lats = polygon.map((p) => p[0]);
    const lngs = polygon.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const spanLat = maxLat - minLat || 1;
    const spanLng = maxLng - minLng || 1;
    const size = 160;
    const pad = 8;
    const scale = (size - pad * 2) / Math.max(spanLat, spanLng);
    return polygon
      .map(
        ([lat, lng]) =>
          `${(pad + (lng - minLng) * scale).toFixed(1)},${(pad + (maxLat - lat) * scale).toFixed(1)}`,
      )
      .join(' ');
  }, [polygon]);

  return (
    <svg
      viewBox="0 0 160 160"
      className="h-32 w-32 shrink-0 rounded-lg border border-border bg-bg-primary"
      role="img"
      aria-label="Polygon preview"
    >
      <polygon
        points={points}
        fill={color}
        fillOpacity={0.25}
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ============================================================
// AREA EDITOR (modal)
// ============================================================

interface FormState {
  id?: string;
  name: string;
  color: string;
  zoneType: ZoneType;
  zipText: string;
  polygonText: string;
  isActive: boolean;
  priority: string;
  travelFee: string;
  surgeEnabled: boolean;
  surgeMultiplier: string;
  surgeEndsAt: string;
  notes: string;
  technicians: Record<string, boolean>; // technicianId -> isPrimary
}

function blankForm(colorIndex: number): FormState {
  return {
    name: '',
    color: AREA_COLORS[colorIndex % AREA_COLORS.length],
    zoneType: 'zip',
    zipText: '',
    polygonText: '',
    isActive: true,
    priority: '0',
    travelFee: '0',
    surgeEnabled: false,
    surgeMultiplier: '1.5',
    surgeEndsAt: '',
    notes: '',
    technicians: {},
  };
}

function formFromArea(area: ServiceArea, assignments: AreaTechnician[]): FormState {
  const techs: Record<string, boolean> = {};
  assignments
    .filter((a) => a.area_id === area.id)
    .forEach((a) => {
      techs[a.technician_id] = a.is_primary;
    });
  return {
    id: area.id,
    name: area.name,
    color: area.color,
    zoneType: area.zone_type,
    zipText: area.zip_codes.join(', '),
    polygonText: polygonToText(area.polygon),
    isActive: area.is_active,
    priority: String(area.priority),
    travelFee: (area.travel_fee_cents / 100).toFixed(2),
    surgeEnabled: area.surge_enabled,
    surgeMultiplier: String(area.surge_multiplier),
    surgeEndsAt: toLocalInput(area.surge_ends_at),
    notes: area.notes ?? '',
    technicians: techs,
  };
}

function AreaEditor({
  initial,
  areas,
  technicians,
  saving,
  onSave,
  onClose,
}: {
  initial: FormState;
  areas: ServiceArea[];
  technicians: Technician[];
  saving: boolean;
  onSave: (input: ServiceAreaInput) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [submitted, setSubmitted] = useState(false);
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(!saving, onClose);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const zipParsed = useMemo(() => parsePostalCodeList(form.zipText), [form.zipText]);
  const polygonParsed = useMemo(
    () =>
      form.zoneType === 'polygon' && form.polygonText.trim()
        ? parsePolygonInput(form.polygonText)
        : null,
    [form.zoneType, form.polygonText],
  );

  const input: ServiceAreaInput = useMemo(
    () => ({
      id: form.id,
      name: form.name,
      color: form.color,
      zoneType: form.zoneType,
      zipCodes: zipParsed.codes,
      polygon: polygonParsed?.polygon ?? null,
      isActive: form.isActive,
      priority: Number(form.priority),
      travelFeeCents: Math.round(Number(form.travelFee) * 100),
      surgeEnabled: form.surgeEnabled,
      surgeMultiplier: Number(form.surgeMultiplier),
      surgeEndsAt: fromLocalInput(form.surgeEndsAt),
      notes: form.notes,
      technicians: Object.entries(form.technicians).map(([technicianId, isPrimary]) => ({
        technicianId,
        isPrimary,
      })),
    }),
    [form, zipParsed.codes, polygonParsed],
  );

  const validationError = useMemo(() => {
    if (form.zoneType === 'polygon' && polygonParsed?.error) return polygonParsed.error;
    return validateAreaInput(input);
  }, [form.zoneType, polygonParsed, input]);

  const overlaps = useMemo(
    () =>
      form.zoneType === 'zip'
        ? findZipOverlaps(areas, { id: form.id, zipCodes: zipParsed.codes })
        : [],
    [areas, form.id, form.zoneType, zipParsed.codes],
  );

  const toggleTech = (id: string) =>
    setForm((f) => {
      const next = { ...f.technicians };
      if (id in next) delete next[id];
      else next[id] = false;
      return { ...f, technicians: next };
    });

  const makePrimary = (id: string) =>
    setForm((f) => ({ ...f, technicians: { ...f.technicians, [id]: !f.technicians[id] } }));

  const handleSubmit = () => {
    setSubmitted(true);
    if (validationError) return;
    onSave(input);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="area-editor-title"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary shadow-xl sm:max-h-[90vh] sm:max-w-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="area-editor-title" className="text-base font-semibold text-text-primary">
            {form.id ? 'Edit service area' : 'New service area'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              value={form.name}
              maxLength={80}
              required
              placeholder="e.g. Downtown core"
              onChange={(e) => set('name', e.target.value)}
            />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Map color</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Map color">
                {AREA_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={form.color === c}
                    aria-label={c}
                    onClick={() => set('color', c)}
                    className={`focus-ring h-8 w-8 rounded-full border-2 ${form.color === c ? 'border-text-primary' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Zone type</span>
            <div
              className="inline-flex rounded-xl border border-border bg-bg-secondary p-1"
              role="tablist"
            >
              {(['zip', 'polygon'] as ZoneType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={form.zoneType === t}
                  onClick={() => set('zoneType', t)}
                  className={`focus-ring rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${form.zoneType === t ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {t === 'zip' ? 'ZIP / postal codes' : 'Polygon'}
                </button>
              ))}
            </div>
          </div>

          {form.zoneType === 'zip' ? (
            <div>
              <Textarea
                label="ZIP / postal codes"
                rows={4}
                value={form.zipText}
                placeholder="78701, 78702, 78703 — US ZIP, ZIP+4, or Canadian postal code / 3-character prefix"
                onChange={(e) => set('zipText', e.target.value)}
                helperText={`${zipParsed.codes.length} valid code${zipParsed.codes.length === 1 ? '' : 's'}`}
                error={
                  zipParsed.invalid.length > 0
                    ? `Not recognized: ${zipParsed.invalid.slice(0, 6).join(', ')}${zipParsed.invalid.length > 6 ? '…' : ''}`
                    : undefined
                }
              />
              {overlaps.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Overlaps {overlaps.map((o) => `${o.area.name} (${o.shared.length})`).join(', ')}
                    . The zone with the higher priority wins for shared codes.
                  </span>
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="min-w-0 flex-1">
                <Textarea
                  label="Polygon points"
                  rows={6}
                  value={form.polygonText}
                  placeholder={'One "latitude, longitude" per line,\nor paste a GeoJSON Polygon'}
                  onChange={(e) => set('polygonText', e.target.value)}
                  helperText={
                    polygonParsed?.polygon
                      ? `${polygonParsed.polygon.length} points`
                      : 'Minimum 3 points. The shape closes automatically.'
                  }
                  error={polygonParsed?.error ?? undefined}
                />
              </div>
              {polygonParsed?.polygon && (
                <PolygonPreview polygon={polygonParsed.polygon} color={form.color} />
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Travel fee ($)"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={form.travelFee}
              onChange={(e) => set('travelFee', e.target.value)}
              helperText="Flat, added after surge"
            />
            <Input
              label="Priority"
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              step={1}
              value={form.priority}
              onChange={(e) => set('priority', e.target.value)}
              helperText="Higher wins overlaps"
            />
            <div>
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Active</span>
              <div className="flex h-[46px] items-center gap-3">
                <Switch
                  checked={form.isActive}
                  onChange={(v) => set('isActive', v)}
                  label="Area active"
                />
                <span className="text-sm text-text-secondary">
                  {form.isActive ? 'Serving' : 'Paused'}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                  <Zap size={14} className="text-warning" /> Surge pricing
                </p>
                <p className="text-xs text-text-secondary">
                  Multiplies the base price (not the travel fee).
                </p>
              </div>
              <Switch
                checked={form.surgeEnabled}
                onChange={(v) => set('surgeEnabled', v)}
                label="Surge pricing"
              />
            </div>
            {form.surgeEnabled && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Input
                  label={`Multiplier (${MIN_SURGE}×–${MAX_SURGE}×)`}
                  type="number"
                  inputMode="decimal"
                  min={MIN_SURGE}
                  max={MAX_SURGE}
                  step="0.05"
                  value={form.surgeMultiplier}
                  onChange={(e) => set('surgeMultiplier', e.target.value)}
                />
                <Input
                  label="Ends at (optional)"
                  type="datetime-local"
                  value={form.surgeEndsAt}
                  onChange={(e) => set('surgeEndsAt', e.target.value)}
                  helperText="Leave empty to keep surge on until you turn it off"
                />
              </div>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-text-primary">
              Technicians covering this area
            </p>
            {technicians.length === 0 ? (
              <p className="rounded-lg bg-bg-secondary px-3 py-3 text-sm text-text-secondary">
                Add technicians on the Team page to assign them here.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {technicians.map((t) => {
                  const selected = t.id in form.technicians;
                  const primary = form.technicians[t.id] === true;
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm text-text-primary">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleTech(t.id)}
                          className="focus-ring h-4 w-4 rounded border-border"
                        />
                        <span className="truncate">{techLabel(t)}</span>
                      </label>
                      {selected && (
                        <button
                          type="button"
                          onClick={() => makePrimary(t.id)}
                          aria-pressed={primary}
                          className={`focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${primary ? 'bg-warning/15 text-warning' : 'text-text-secondary hover:text-text-primary'}`}
                        >
                          <Star size={12} className={primary ? 'fill-current' : ''} /> Primary
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-1.5 text-xs text-text-secondary">
              The AI dispatcher tries primary technicians first, then the least-loaded technician in
              the area.
            </p>
          </div>

          <Textarea
            label="Internal notes"
            rows={2}
            maxLength={500}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p
            role="alert"
            className={`text-xs ${submitted && validationError ? 'text-danger' : 'text-transparent'}`}
          >
            {submitted && validationError ? validationError : '.'}
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create area'}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// AREA CARD
// ============================================================

function AreaCard({
  area,
  technicians,
  canManage,
  busy,
  onEdit,
  onDelete,
  onToggle,
}: {
  area: ServiceArea;
  technicians: Technician[];
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (active: boolean) => void;
}) {
  const surgeLive = isSurgeActive(area);
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: area.color }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">{area.name}</h3>
            <p className="text-xs text-text-secondary">
              {area.zone_type === 'zip'
                ? `${area.zip_codes.length} ZIP / postal code${area.zip_codes.length === 1 ? '' : 's'}`
                : `Polygon · ${area.polygon?.length ?? 0} points`}
              {' · '}Priority {area.priority}
            </p>
          </div>
        </div>
        <Switch
          checked={area.is_active}
          onChange={onToggle}
          label={`${area.name} active`}
          disabled={!canManage || busy}
        />
      </div>

      {area.zone_type === 'zip' && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {area.zip_codes.slice(0, 8).map((z) => (
            <span
              key={z}
              className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary"
            >
              {z}
            </span>
          ))}
          {area.zip_codes.length > 8 && (
            <span className="px-1 py-0.5 text-xs text-text-secondary">
              +{area.zip_codes.length - 8} more
            </span>
          )}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-text-secondary">Travel fee</dt>
          <dd className="mt-0.5 text-sm font-semibold text-text-primary">
            {area.travel_fee_cents > 0 ? formatCents(area.travel_fee_cents) : 'None'}
          </dd>
        </div>
        <div>
          <dt className="text-text-secondary">Surge</dt>
          <dd
            className={`mt-0.5 text-sm font-semibold ${surgeLive ? 'text-warning' : 'text-text-primary'}`}
          >
            {surgeLive ? `${area.surge_multiplier}× live` : area.surge_enabled ? 'Expired' : 'Off'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {technicians.length === 0 ? (
          <span className="flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
            <AlertTriangle size={12} /> No technician assigned
          </span>
        ) : (
          technicians.map((t) => (
            <span
              key={t.id}
              className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-primary"
            >
              {techLabel(t)}
            </span>
          ))
        )}
      </div>

      {canManage && (
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil size={14} /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="text-danger"
          >
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

// ============================================================
// OUT-OF-AREA AI REPLY
// ============================================================

function OutOfAreaCard({
  settings,
  canManage,
  accountOwnerId,
  onSaved,
}: {
  settings: ServiceAreaSettings | null;
  canManage: boolean;
  accountOwnerId: string | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<OutOfAreaMode>(settings?.out_of_area_mode ?? 'waitlist');
  const [message, setMessage] = useState(settings?.out_of_area_message ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(settings?.out_of_area_mode ?? 'waitlist');
    setMessage(settings?.out_of_area_message ?? '');
  }, [settings]);

  const dirty =
    mode !== (settings?.out_of_area_mode ?? 'waitlist') ||
    message.trim() !== (settings?.out_of_area_message ?? '');
  const preview = outOfAreaReply({ out_of_area_mode: mode, out_of_area_message: message });

  const save = async () => {
    setSaving(true);
    try {
      await saveServiceAreaSettings(accountOwnerId, mode, message);
      toast('Out-of-area reply saved.', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the out-of-area reply.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <PhoneCall size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Out-of-area AI reply</h2>
          <p className="text-xs text-text-secondary">
            What your AI receptionist says when a caller is outside every active area.
          </p>
        </div>
      </div>

      <div
        className="mt-4 grid gap-2 sm:grid-cols-3"
        role="radiogroup"
        aria-label="Out-of-area behavior"
      >
        {(Object.keys(MODE_LABELS) as OutOfAreaMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            disabled={!canManage}
            onClick={() => setMode(m)}
            className={`focus-ring rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed ${mode === m ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'}`}
          >
            <span className="block text-sm font-semibold text-text-primary">
              {MODE_LABELS[m].title}
            </span>
            <span className="mt-0.5 block text-xs text-text-secondary">{MODE_LABELS[m].hint}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <Textarea
          label="Custom message (optional)"
          rows={3}
          maxLength={600}
          disabled={!canManage}
          value={message}
          placeholder={DEFAULT_OUT_OF_AREA_MESSAGES[mode]}
          onChange={(e) => setMessage(e.target.value)}
          helperText="Leave empty to use the default wording for the selected behavior."
        />
      </div>

      <div className="mt-3 rounded-xl bg-bg-secondary px-4 py-3">
        <p className="text-xs font-medium text-text-secondary">What the caller hears</p>
        <p className="mt-1 text-sm text-text-primary">“{preview}”</p>
      </div>

      {canManage && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save reply'}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ============================================================
// ADDRESS TESTER
// ============================================================

type TestOutcome =
  | {
      kind: 'in_area';
      area: ServiceArea;
      others: string[];
      basePrice: number | null;
      techNames: string[];
    }
  | { kind: 'out_of_area' }
  | { kind: 'unknown' }
  | { kind: 'none_configured' };

function AddressTester({
  areas,
  assignments,
  technicians,
  settings,
}: {
  areas: ServiceArea[];
  assignments: AreaTechnician[];
  technicians: Technician[];
  settings: ServiceAreaSettings | null;
}) {
  const [query, setQuery] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const runRef = useRef(0);

  const run = async () => {
    const text = query.trim();
    if (!text) return;
    const runId = ++runRef.current;
    setChecking(true);
    setNote(null);
    try {
      let latitude: number | null = null;
      let longitude: number | null = null;
      const coord = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (coord) {
        latitude = Number(coord[1]);
        longitude = Number(coord[2]);
      }
      const postalCode = coord
        ? null
        : (extractPostalCode(text) ?? parsePostalCodeList(text).codes[0] ?? null);

      const needsGeocode = !coord && areas.some((a) => a.is_active && a.zone_type === 'polygon');
      if (needsGeocode) {
        try {
          const res = await geocodeTargets([
            { type: 'scratch', id: 'service-area-test', address: text },
          ]);
          const hit = res.results[0];
          if (
            hit?.status === 'geocoded' &&
            typeof hit.latitude === 'number' &&
            typeof hit.longitude === 'number'
          ) {
            latitude = hit.latitude;
            longitude = hit.longitude;
          } else {
            setNote('Could not locate that address on the map — polygon zones were not checked.');
          }
        } catch {
          setNote('Address lookup is unavailable right now — polygon zones were not checked.');
        }
      }

      if (runId !== runRef.current) return;
      const result = resolveServiceArea(areas, { postalCode, latitude, longitude });
      if (result.status === 'in_area') {
        const base = basePrice.trim() === '' ? null : Math.round(Number(basePrice) * 100);
        const ids = assignments
          .filter((a) => a.area_id === result.area.id)
          .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
        const techNames = ids
          .map((a) => technicians.find((t) => t.id === a.technician_id))
          .filter((t): t is Technician => Boolean(t))
          .map(techLabel);
        setOutcome({
          kind: 'in_area',
          area: result.area,
          others: result.alsoMatched.map((a) => a.name),
          basePrice: base !== null && Number.isFinite(base) ? base : null,
          techNames,
        });
      } else if (result.status === 'out_of_area') setOutcome({ kind: 'out_of_area' });
      else if (result.status === 'unknown') setOutcome({ kind: 'unknown' });
      else setOutcome({ kind: 'none_configured' });
    } finally {
      if (runId === runRef.current) setChecking(false);
    }
  };

  const quote =
    outcome?.kind === 'in_area' && outcome.basePrice !== null
      ? computeAreaQuote(outcome.area, outcome.basePrice)
      : null;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Search size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Check an address</h2>
          <p className="text-xs text-text-secondary">
            Test exactly what the AI receptionist and dispatcher will decide.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <Input
          label="Address, ZIP, or lat, lng"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="123 Main St, Austin, TX 78701"
        />
        <Input
          label="Base price ($)"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={basePrice}
          onChange={(e) => setBasePrice(e.target.value)}
          placeholder="Optional"
        />
        <Button
          size="sm"
          onClick={run}
          disabled={checking || !query.trim()}
          className="sm:mb-[2px]"
        >
          {checking && <Loader2 size={14} className="animate-spin" />}
          {checking ? 'Checking…' : 'Check'}
        </Button>
      </div>

      <div aria-live="polite" className="mt-4">
        {note && <p className="mb-2 text-xs text-warning">{note}</p>}
        {outcome?.kind === 'in_area' && (
          <div className="rounded-xl border border-success/30 bg-success/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-success">
              <CheckCircle2 size={16} /> In service area: {outcome.area.name}
            </p>
            {outcome.others.length > 0 && (
              <p className="mt-1 text-xs text-text-secondary">
                Also matches {outcome.others.join(', ')} — higher priority wins.
              </p>
            )}
            <p className="mt-2 text-xs text-text-secondary">
              Technicians:{' '}
              {outcome.techNames.length > 0
                ? outcome.techNames.join(', ')
                : 'none assigned — AI dispatch will use any available technician'}
            </p>
            {quote && (
              <ul className="mt-3 space-y-1 text-sm text-text-primary">
                <li className="flex justify-between">
                  <span>Base</span>
                  <span>{formatCents(quote.baseCents)}</span>
                </li>
                {quote.surgeApplied && (
                  <li className="flex justify-between text-warning">
                    <span>Surge {quote.surgeMultiplier}×</span>
                    <span>+{formatCents(quote.surgeAmountCents)}</span>
                  </li>
                )}
                <li className="flex justify-between">
                  <span>Travel fee</span>
                  <span>{formatCents(quote.travelFeeCents)}</span>
                </li>
                <li className="flex justify-between border-t border-border pt-1 font-semibold">
                  <span>Total</span>
                  <span>{formatCents(quote.totalCents)}</span>
                </li>
              </ul>
            )}
          </div>
        )}
        {outcome?.kind === 'out_of_area' && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger">
              <XCircle size={16} /> Outside every active area
            </p>
            <p className="mt-2 text-sm text-text-primary">AI says: “{outOfAreaReply(settings)}”</p>
          </div>
        )}
        {outcome?.kind === 'unknown' && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-warning">
              <HelpCircle size={16} /> Not enough location detail
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              Include a ZIP / postal code (and a full street address for polygon zones). Callers in
              this state are never rejected — the AI asks the office to confirm.
            </p>
          </div>
        )}
        {outcome?.kind === 'none_configured' && (
          <p className="rounded-xl bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
            No active areas yet, so every address is accepted.
          </p>
        )}
      </div>
    </Card>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ServiceAreasPage() {
  const navigate = useNavigate();
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  // Same derivation as NotificationsContext: tenant data is keyed by the OWNER's id, never a team member's own id.
  const accountOwnerId = isOwner ? (profile?.id ?? null) : (teamMember?.account_owner_id ?? null);
  const canView =
    isOwner ||
    permissions.can_view_all_jobs ||
    permissions.can_manage_team ||
    teamMember?.role === 'admin';
  const canManage = isOwner || permissions.can_manage_team || teamMember?.role === 'admin';

  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [assignments, setAssignments] = useState<AreaTechnician[]>([]);
  const [settings, setSettings] = useState<ServiceAreaSettings | null>(null);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editor, setEditor] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ServiceArea | null>(null);
  const loadId = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    const id = ++loadId.current;
    setLoadError(false);
    try {
      const [bundle, techRes] = await Promise.all([
        fetchServiceAreaBundle(accountOwnerId),
        supabase
          .from('team_members')
          .select('id, member_name, member_email')
          .eq('account_owner_id', accountOwnerId)
          .eq('role', 'technician')
          .eq('invite_status', 'active')
          .order('member_name'),
      ]);
      if (techRes.error) throw techRes.error;
      if (id !== loadId.current) return;
      setAreas(bundle.areas);
      setAssignments(bundle.assignments);
      setSettings(bundle.settings);
      setTechnicians((techRes.data as Technician[]) ?? []);
    } catch {
      if (id === loadId.current) setLoadError(true);
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (canView) load();
    else setLoading(false);
  }, [canView, load]);

  const techsByArea = useMemo(() => {
    const byId = new Map(technicians.map((t) => [t.id, t]));
    const map = new Map<string, Technician[]>();
    [...assignments]
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .forEach((a) => {
        const tech = byId.get(a.technician_id);
        if (!tech) return;
        map.set(a.area_id, [...(map.get(a.area_id) ?? []), tech]);
      });
    return map;
  }, [assignments, technicians]);

  const stats = useMemo(() => {
    const active = areas.filter((a) => a.is_active);
    return {
      active: active.length,
      codes: new Set(active.flatMap((a) => a.zip_codes)).size,
      techs: new Set(
        assignments
          .filter((a) => active.some((x) => x.id === a.area_id))
          .map((a) => a.technician_id),
      ).size,
      surge: active.filter((a) => isSurgeActive(a)).length,
    };
  }, [areas, assignments]);

  const handleSave = async (input: ServiceAreaInput) => {
    setSaving(true);
    try {
      await saveServiceArea(accountOwnerId, input);
      toast(input.id ? 'Service area updated.' : 'Service area created.', 'success');
      setEditor(null);
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      const duplicate = /duplicate key|uq_service_areas_user_name/i.test(message);
      toast(
        duplicate
          ? 'An area with that name already exists.'
          : 'Could not save this area. Please try again.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (area: ServiceArea, active: boolean) => {
    setBusyId(area.id);
    const previous = areas;
    setAreas((list) => list.map((a) => (a.id === area.id ? { ...a, is_active: active } : a)));
    try {
      await setServiceAreaActive(accountOwnerId, area.id, active);
    } catch {
      setAreas(previous);
      toast('Could not update this area.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusyId(target.id);
    try {
      await deleteServiceArea(accountOwnerId, target.id);
      toast(`Deleted “${target.name}”.`, 'success');
      setPendingDelete(null);
      await load();
    } catch {
      toast('Could not delete this area.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const header = (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <MapPinned size={16} />
            </span>
            <h1 className="text-2xl font-bold text-text-primary">Service Areas</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            ZIP and polygon zones with travel fees, surge pricing, technician coverage, and an
            out-of-area AI reply.
          </p>
        </div>
      </div>
      {canView && canManage && !loadError && (
        <Button size="sm" onClick={() => setEditor(blankForm(areas.length))}>
          <Plus size={16} /> New area
        </Button>
      )}
    </div>
  );

  let body: JSX.Element;
  if (!canView) {
    body = (
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to Service Areas"
        description="Ask the account owner to grant you team-management or job access."
        action={{ label: 'Back to dashboard', onClick: () => navigate('/dashboard') }}
      />
    );
  } else if (loading) {
    body = (
      <div className="space-y-6" aria-busy="true" aria-label="Loading service areas">
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} rows={3} />
      </div>
    );
  } else if (loadError) {
    body = (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your service areas"
        description="Check your connection and try again."
        action={{
          label: 'Try again',
          onClick: () => {
            setLoading(true);
            load();
          },
        }}
      />
    );
  } else {
    body = (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={MapPinned} label="Active areas" value={stats.active} />
          <StatCard icon={Hash} label="ZIP codes covered" value={stats.codes} />
          <StatCard icon={Users} label="Technicians assigned" value={stats.techs} />
          <StatCard icon={Zap} label="Surge live" value={stats.surge} />
        </div>

        {areas.length === 0 ? (
          <EmptyState
            icon={MapPinned}
            title="Define where you work"
            description="Until you add an area, your AI receptionist books every address. Add zones to set travel fees, surge pricing, and politely turn away callers outside your territory."
            action={
              canManage
                ? { label: 'Create your first area', onClick: () => setEditor(blankForm(0)) }
                : undefined
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {areas.map((area) => (
              <AreaCard
                key={area.id}
                area={area}
                technicians={techsByArea.get(area.id) ?? []}
                canManage={canManage}
                busy={busyId === area.id}
                onEdit={() => setEditor(formFromArea(area, assignments))}
                onDelete={() => setPendingDelete(area)}
                onToggle={(v) => handleToggle(area, v)}
              />
            ))}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-2">
          <OutOfAreaCard
            settings={settings}
            canManage={canManage}
            accountOwnerId={accountOwnerId}
            onSaved={load}
          />
          <AddressTester
            areas={areas}
            assignments={assignments}
            technicians={technicians}
            settings={settings}
          />
        </div>

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DashboardLayout activeLabel="Service Areas">
      {header}
      {body}

      <AnimatePresence>
        {editor && (
          <AreaEditor
            key={editor.id ?? 'new'}
            initial={editor}
            areas={areas}
            technicians={technicians}
            saving={saving}
            onSave={handleSave}
            onClose={() => setEditor(null)}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this service area?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” will be removed. Callers in this zone may be treated as out of area if no other zone covers them.`
            : ''
        }
        confirmLabel="Yes, delete this"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}
