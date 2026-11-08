import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/Skeleton';
import {
  CANONICAL_STATUSES,
  STATUS_COLORS,
  STATUS_COLOR_CLASSES,
  TEAM_ROLES,
  activeDefinitions,
  isCanonicalStatus,
  type CanonicalStatus,
  type DefinitionDraft,
  type DefinitionErrors,
  type StatusColor,
  type StatusDefinition,
  type StatusTransition,
  type TeamRole,
} from '@/lib/statusEngine';
import {
  createStatusDefinition,
  deleteStatusTransition,
  listStatusDefinitions,
  listStatusTransitions,
  saveStatusTransition,
  setStatusDefinitionArchived,
  updateStatusDefinition,
} from '@/lib/statusEngineApi';
import { useStatusEngineT } from '@/i18n/statusEngineNamespace';
import { listCustomFields, useAccountOwnerId } from '@/lib/customFieldsApi';
import { fetchInstalls } from '@/lib/tradePacksApi';
import { TRADE_PACKS, type PackKey } from '@/lib/tradePacks';
import { STARTER_STATUSES, planStarterStatuses } from '@/lib/tradePacks/starterConfigs';
import { installStarterStatuses } from '@/lib/tradePacks/starterConfigsApi';

const NAV_LABEL = 'Job Statuses';

interface FormState {
  id: string | null; // null = new
  label: string;
  color: StatusColor;
  canonical: CanonicalStatus;
  requiresNote: boolean;
  requiredFields: string;
  sla: string;
  isSystem: boolean;
  version: number;
}

function toForm(def: StatusDefinition | null): FormState {
  return {
    id: def?.id ?? null,
    label: def?.label ?? '',
    color: def?.color ?? 'neutral',
    canonical: def?.canonical_status ?? 'on_hold',
    requiresNote: def?.requires_note ?? false,
    requiredFields: (def?.required_fields ?? []).join(', '),
    sla: def?.sla_minutes != null ? String(def.sla_minutes) : '',
    isSystem: def?.is_system ?? false,
    version: def?.version ?? 1,
  };
}

function parseFields(raw: string): string[] {
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function StatusSettingsPage() {
  const { isOwner } = useAuth();
  const { t, statusLabel } = useStatusEngineT();
  const { toast } = useToast();
  const uid = useId();
  const ownerId = useAccountOwnerId();
  const [installed, setInstalled] = useState<PackKey[]>([]);
  const [jobFieldKeys, setJobFieldKeys] = useState<ReadonlySet<string>>(new Set());
  const [starterBusy, setStarterBusy] = useState<PackKey | null>(null);
  const [defs, setDefs] = useState<StatusDefinition[]>([]);
  const [rules, setRules] = useState<StatusTransition[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<DefinitionErrors>({});
  const [saving, setSaving] = useState(false);
  const [rule, setRule] = useState<{ from: string; to: string; roles: TeamRole[]; note: boolean }>({ from: '', to: '', roles: [...TEAM_ROLES], note: false });

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [d, r] = await Promise.all([listStatusDefinitions(), listStatusTransitions()]);
      setDefs(d);
      setRules(r);
      setState('ready');
      // Starter templates are optional: a failure here must never block the page.
      try {
        const [installs, fields] = await Promise.all([fetchInstalls(ownerId), ownerId ? listCustomFields('job', ownerId) : Promise.resolve([])]);
        setInstalled(installs.filter((i) => i.enabled).map((i) => i.pack_key as PackKey).filter((k) => k in STARTER_STATUSES));
        setJobFieldKeys(new Set(fields.filter((f) => f.archived_at === null).map((f) => f.key)));
      } catch {
        setInstalled([]);
      }
    } catch {
      setState('error');
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const active = activeDefinitions(defs);
    return showArchived ? [...active, ...defs.filter((d) => d.archived_at !== null)] : active;
  }, [defs, showArchived]);
  const active = useMemo(() => activeDefinitions(defs), [defs]);
  const byId = useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);

  const errorText = (code: string | undefined) => (code ? t(`errors.${code}`) : undefined);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    const slaValue = form.sla.trim() === '' ? null : Number(form.sla);
    const draft: DefinitionDraft = {
      label: form.label,
      color: form.color,
      canonical_status: form.canonical,
      requires_note: form.requiresNote,
      required_fields: parseFields(form.requiredFields),
      sla_minutes: slaValue !== null && Number.isFinite(slaValue) ? slaValue : slaValue === null ? null : -1,
    };
    const result = form.id
      ? await updateStatusDefinition(
          form.id,
          {
            label: draft.label.trim(),
            color: draft.color,
            canonical_status: draft.canonical_status,
            requires_note: draft.requires_note ?? false,
            required_fields: draft.required_fields ?? [],
            sla_minutes: draft.sla_minutes ?? null,
          },
          defs,
        )
      : await createStatusDefinition(draft, defs);
    setSaving(false);
    if (result.ok) {
      setErrors({});
      setForm(null);
      toast(t('settings.saved'), 'success');
      await load();
    } else {
      setErrors(result.errors);
      if (result.serverError) toast(t('settings.saveFailed'), 'error');
    }
  };

  const toggleArchive = async (def: StatusDefinition) => {
    const archiving = def.archived_at === null;
    const ok = await setStatusDefinitionArchived(def.id, archiving);
    if (ok) {
      toast(t(archiving ? 'settings.archivedToast' : 'settings.restoredToast'), 'success');
      await load();
    } else {
      toast(t('settings.saveFailed'), 'error');
    }
  };

  const addRule = async () => {
    if (!rule.to || rule.roles.length === 0) return;
    const ok = await saveStatusTransition({ fromDefinitionId: rule.from || null, toDefinitionId: rule.to, allowedRoles: rule.roles, requiresNote: rule.note });
    if (ok) {
      toast(t('settings.rules.saved'), 'success');
      setRule({ from: '', to: '', roles: [...TEAM_ROLES], note: false });
      await load();
    } else {
      toast(t('settings.saveFailed'), 'error');
    }
  };

  const installStarters = async (packKey: PackKey) => {
    setStarterBusy(packKey);
    try {
      const res = await installStarterStatuses(packKey, defs, jobFieldKeys);
      toast(t('starter.done', { added: res.added, skipped: res.skipped }), res.added > 0 ? 'success' : 'info');
      await load();
    } catch {
      toast(t('settings.saveFailed'), 'error');
    } finally {
      setStarterBusy(null);
    }
  };

  const removeRule = async (id: string) => {
    if (await deleteStatusTransition(id)) await load();
    else toast(t('settings.saveFailed'), 'error');
  };

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel={NAV_LABEL}>
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <h1 className="text-lg font-semibold text-text-primary">{t('settings.title')}</h1>
          <p className="mt-1.5 text-sm text-text-secondary">{t('settings.ownerOnly')}</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={NAV_LABEL}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <ListChecks size={22} aria-hidden="true" /> {t('settings.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('settings.subtitle')}</p>
        </div>
        <Button type="button" size="sm" onClick={() => { setErrors({}); setForm(toForm(null)); }} disabled={state !== 'ready'}>
          <Plus size={14} aria-hidden="true" /> {t('settings.add')}
        </Button>
      </div>

      {state === 'loading' && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="rounded-2xl border border-border bg-bg-secondary p-6 text-center">
          <p className="text-sm text-text-primary">{t('settings.loadFailed')}</p>
          <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void load()}>{t('settings.retry')}</Button>
        </div>
      )}

      {state === 'ready' && (
        <div className="space-y-8">
          <section aria-label={t('settings.title')}>
            <Checkbox label={t('settings.showArchived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="mb-3" />
            <ul className="space-y-2">
              {visible.map((d) => {
                const c = STATUS_COLOR_CLASSES[d.color];
                const archived = d.archived_at !== null;
                return (
                  <li key={d.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 ${archived ? 'opacity-60' : ''}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.dot}`} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {statusLabel(d)}
                          {d.is_system && <span className={`ms-2 rounded-full px-2 py-0.5 text-[11px] ${c.badge}`}>{t('settings.systemBadge')}</span>}
                          {archived && <span className="ms-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{t('settings.archivedBadge')}</span>}
                        </p>
                        <p className="text-xs text-text-secondary">
                          {t('settings.countsAs', { status: t(`canonical.${d.canonical_status}`) })} · {t('settings.version', { version: d.version })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!archived && (
                        <Button type="button" size="xs" variant="secondary" onClick={() => { setErrors({}); setForm(toForm(d)); }}>{t('settings.edit')}</Button>
                      )}
                      {!d.is_system && (
                        <Button type="button" size="xs" variant="ghost" onClick={() => void toggleArchive(d)}>
                          {archived ? t('settings.restore') : t('settings.archive')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {form && (
            <section aria-labelledby={`${uid}-form`} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <h2 id={`${uid}-form`} className="mb-4 text-sm font-semibold text-text-primary">{form.id ? t('settings.edit') : t('settings.add')}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label={t('settings.fieldLabel')} value={form.label} maxLength={60} error={errorText(errors.label)} onChange={(e) => setForm({ ...form, label: e.target.value })} />
                <Select
                  label={t('settings.fieldMaps')}
                  helperText={t('settings.fieldMapsHelp')}
                  error={errorText(errors.canonical_status)}
                  disabled={form.isSystem}
                  value={form.canonical}
                  onChange={(e) => isCanonicalStatus(e.target.value) && setForm({ ...form, canonical: e.target.value })}
                >
                  {CANONICAL_STATUSES.map((s) => (
                    <option key={s} value={s}>{t(`canonical.${s}`)}</option>
                  ))}
                </Select>
                <fieldset className="sm:col-span-2">
                  <legend className="mb-2 text-xs font-medium text-text-secondary">{t('settings.fieldColor')}</legend>
                  <div className="flex flex-wrap gap-2">
                    {STATUS_COLORS.map((c) => (
                      <label key={c} className={`focus-within:ring-2 focus-within:ring-accent inline-flex min-h-[32px] cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-xs ${form.color === c ? 'border-accent bg-bg-tertiary text-text-primary' : 'border-border text-text-secondary'}`}>
                        <input type="radio" name={`${uid}-color`} className="sr-only" checked={form.color === c} onChange={() => setForm({ ...form, color: c })} />
                        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${STATUS_COLOR_CLASSES[c].dot}`} />
                        {t(`colors.${c}`)}
                      </label>
                    ))}
                  </div>
                  {errors.color && <p role="alert" className="mt-1 text-xs text-danger">{errorText(errors.color)}</p>}
                </fieldset>
                <Input label={t('settings.fieldRequired')} helperText={t('settings.fieldRequiredHelp')} value={form.requiredFields} error={errorText(errors.required_fields)} onChange={(e) => setForm({ ...form, requiredFields: e.target.value })} />
                <Input
                  label={t('settings.fieldSla')}
                  helperText={t('settings.fieldSlaHelp')}
                  inputMode="numeric"
                  value={form.sla}
                  error={errorText(errors.sla_minutes)}
                  disabled={form.isSystem === false && !['on_hold', 'waiting_on_parts', 'waiting_on_customer', 'needs_follow_up', 'return_visit_needed'].includes(form.canonical)}
                  onChange={(e) => setForm({ ...form, sla: e.target.value.replace(/[^0-9]/g, '') })}
                />
                <Checkbox label={t('settings.fieldNote')} checked={form.requiresNote} onChange={(e) => setForm({ ...form, requiresNote: e.target.checked })} className="sm:col-span-2" />
              </div>
              {errors.key && <p role="alert" className="mt-3 text-xs text-danger">{errorText(errors.key)}</p>}
              {errors.form && <p role="alert" className="mt-3 text-xs text-danger">{errorText(errors.form)}</p>}
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>{t('settings.cancel')}</Button>
                <Button type="button" size="sm" loading={saving} onClick={() => void save()}>{t('settings.save')}</Button>
              </div>
            </section>
          )}

          <section aria-labelledby={`${uid}-starter`}>
            <h2 id={`${uid}-starter`} className="text-sm font-semibold text-text-primary">{t('starter.title')}</h2>
            <p className="mt-1 max-w-2xl text-xs text-text-secondary">{t('starter.help')}</p>
            {installed.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">{t('starter.none')}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {installed.map((key) => {
                  const pack = TRADE_PACKS.find((p) => p.key === key);
                  const pending = planStarterStatuses(key, defs, jobFieldKeys).create.length;
                  return (
                    <li key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{pack?.name ?? key}</p>
                        <p className="text-xs text-text-secondary">{t('starter.count', { count: STARTER_STATUSES[key].length })}</p>
                      </div>
                      <Button type="button" size="sm" variant="secondary" disabled={pending === 0} loading={starterBusy === key} onClick={() => void installStarters(key)}>
                        {pending === 0 ? t('starter.installed') : t('starter.install')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby={`${uid}-rules`}>
            <h2 id={`${uid}-rules`} className="text-sm font-semibold text-text-primary">{t('settings.rules.title')}</h2>
            <p className="mt-1 max-w-2xl text-xs text-text-secondary">{t('settings.rules.help')}</p>
            {rules.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">{t('settings.rules.empty')}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {rules.map((r) => {
                  const from = r.from_definition_id ? byId.get(r.from_definition_id) : null;
                  const to = byId.get(r.to_definition_id);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary">
                      <span>
                        {from ? statusLabel(from) : t('settings.rules.anyFrom')} → {to ? statusLabel(to) : '—'}
                        <span className="ms-2 text-xs text-text-secondary">{r.allowed_roles.map((x) => t(`roles.${x}`)).join(', ')}</span>
                      </span>
                      <Button type="button" size="xs" variant="ghost" onClick={() => void removeRule(r.id)}>{t('settings.rules.remove')}</Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-4 grid gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-2">
              <Select label={t('settings.rules.from')} value={rule.from} onChange={(e) => setRule({ ...rule, from: e.target.value })}>
                <option value="">{t('settings.rules.anyFrom')}</option>
                {active.map((d) => <option key={d.id} value={d.id}>{statusLabel(d)}</option>)}
              </Select>
              <Select label={t('settings.rules.to')} value={rule.to} onChange={(e) => setRule({ ...rule, to: e.target.value })}>
                <option value="">{t('panel.choose')}</option>
                {active.map((d) => <option key={d.id} value={d.id}>{statusLabel(d)}</option>)}
              </Select>
              <fieldset className="sm:col-span-2">
                <legend className="mb-2 text-xs font-medium text-text-secondary">{t('settings.rules.roles')}</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {TEAM_ROLES.map((role) => (
                    <Checkbox
                      key={role}
                      label={t(`roles.${role}`)}
                      checked={rule.roles.includes(role)}
                      onChange={(e) => setRule({ ...rule, roles: e.target.checked ? [...rule.roles, role] : rule.roles.filter((x) => x !== role) })}
                    />
                  ))}
                </div>
              </fieldset>
              <Checkbox label={t('settings.rules.note')} checked={rule.note} onChange={(e) => setRule({ ...rule, note: e.target.checked })} />
              <div className="flex justify-end sm:col-span-2">
                <Button type="button" size="sm" disabled={!rule.to || rule.roles.length === 0} onClick={() => void addRule()}>{t('settings.rules.add')}</Button>
              </div>
            </div>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}
