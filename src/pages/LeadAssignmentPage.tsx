import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, GitBranch, Loader2, Lock, Pencil, Plus, Save, Trash2, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  DEFAULT_SETTINGS,
  EMPTY_RULE,
  STRATEGY_META,
  deleteRule,
  describeRule,
  eventLabel,
  fetchAgentReport,
  fetchAgents,
  fetchRecentEvents,
  fetchRules,
  fetchServiceAreas,
  fetchSettings,
  formatList,
  formatMinutes,
  methodLabel,
  moveInList,
  parseList,
  previewAssignment,
  rangeForDays,
  removeAgent,
  reorderRules,
  resolveOwnerId,
  ruleWarnings,
  saveAgent,
  saveRule,
  saveSettings,
  summarizeReport,
  validateRule,
  validateSettings,
  type AgentReportRow,
  type AssignmentAgent,
  type AssignmentEvent,
  type AssignmentRule,
  type AssignmentSettings,
  type AssignmentStrategy,
  type PreviewResult,
  type RuleDraft,
  type ServiceAreaOption,
} from '@/lib/leadAssignment';

const PAGE_LABEL = 'Lead Assignment';
type Tab = 'settings' | 'rules' | 'agents' | 'performance' | 'test';
const TABS: { key: Tab; label: string }[] = [
  { key: 'settings', label: 'Settings & SLA' },
  { key: 'rules', label: 'Rules' },
  { key: 'agents', label: 'Agents' },
  { key: 'performance', label: 'Performance' },
  { key: 'test', label: 'Test & activity' },
];

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm text-text-primary">
      <input
        type="checkbox"
        role="switch"
        className="h-4 w-4 accent-[var(--accent,#2563eb)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function LeadAssignmentPage() {
  const { user, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const ownerId = resolveOwnerId(user, teamMember);
  const canManage = Boolean(permissions?.can_manage_team);

  const [tab, setTab] = useState<Tab>('settings');
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AssignmentSettings>(DEFAULT_SETTINGS);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [agents, setAgents] = useState<AssignmentAgent[]>([]);
  const [areas, setAreas] = useState<ServiceAreaOption[]>([]);
  const [report, setReport] = useState<AgentReportRow[]>([]);
  const [events, setEvents] = useState<AssignmentEvent[]>([]);
  const [days, setDays] = useState(30);
  const [saving, setSaving] = useState(false);

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftText, setDraftText] = useState({ services: '', languages: '', postal_codes: '', sources: '' });
  const [previousPool, setPreviousPool] = useState<string[]>([]);
  const [toDelete, setToDelete] = useState<AssignmentRule | null>(null);

  const [probe, setProbe] = useState({ service: '', postal: '', language: '', source: '' });
  const [probeResult, setProbeResult] = useState<PreviewResult | null>(null);
  const [probing, setProbing] = useState(false);

  const areaNames = useMemo(() => Object.fromEntries(areas.map((a) => [a.id, a.name])), [areas]);
  const agentNames = useMemo(() => Object.fromEntries(agents.map((a) => [a.team_member_id, a.name])), [agents]);
  const openByAgent = useMemo(
    () => Object.fromEntries(report.filter((r) => r.member_id).map((r) => [r.member_id as string, r.open_leads])),
    [report],
  );
  const totals = useMemo(() => summarizeReport(report), [report]);

  const loadAll = useCallback(async () => {
    if (!ownerId) return;
    try {
      const [s, r, a, z, ev] = await Promise.all([
        fetchSettings(),
        fetchRules(),
        fetchAgents(ownerId),
        fetchServiceAreas().catch(() => [] as ServiceAreaOption[]),
        fetchRecentEvents().catch(() => [] as AssignmentEvent[]),
      ]);
      setSettings(s);
      setRules(r);
      setAgents(a);
      setAreas(z);
      setEvents(ev);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load lead assignment.', 'error');
    } finally {
      setLoading(false);
    }
  }, [ownerId, toast]);

  const loadReport = useCallback(async () => {
    if (!canManage) return;
    try {
      const { from, to } = rangeForDays(days);
      setReport(await fetchAgentReport(from, to));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the report.', 'error');
    }
  }, [canManage, days, toast]);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { void loadReport(); }, [loadReport]);

  if (!canManage) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <EmptyState icon={Lock} title="You don't have access" description="Managing lead assignment needs the “Manage Team” permission." />
      </DashboardLayout>
    );
  }

  if (loading) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }

  const enrolled = agents.filter((a) => a.enrolled);

  async function onSaveSettings() {
    const errors = validateSettings(settings);
    if (errors.length) return toast(errors[0], 'error');
    if (settings.enabled && enrolled.filter((a) => a.accepts_leads).length === 0) {
      return toast('Enrol at least one agent (Agents tab) before turning assignment on.', 'error');
    }
    setSaving(true);
    try {
      await saveSettings(ownerId as string, settings);
      toast('Settings saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save settings.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function onToggleAgent(agent: AssignmentAgent, patch: Partial<Pick<AssignmentAgent, 'accepts_leads' | 'max_open_leads'>>) {
    const next = { accepts_leads: agent.accepts_leads, max_open_leads: agent.max_open_leads, ...patch };
    try {
      await saveAgent(ownerId as string, agent.team_member_id, next);
      setAgents((list) => list.map((a) => (a.team_member_id === agent.team_member_id ? { ...a, ...next, enrolled: true } : a)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the agent.', 'error');
    }
  }

  async function onUnenrol(agent: AssignmentAgent) {
    try {
      await removeAgent(agent.team_member_id);
      setAgents((list) => list.map((a) => (a.team_member_id === agent.team_member_id ? { ...a, enrolled: false, accepts_leads: false } : a)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the agent.', 'error');
    }
  }

  function openEditor(rule?: AssignmentRule) {
    const base: RuleDraft = rule ? { ...rule } : { ...EMPTY_RULE, priority: (rules.length + 1) * 10 };
    setDraft(base);
    setPreviousPool(rule?.agent_ids ?? []);
    setDraftText({
      services: formatList(base.services),
      languages: formatList(base.languages),
      postal_codes: formatList(base.postal_codes),
      sources: formatList(base.sources),
    });
  }

  const effectiveDraft: RuleDraft | null = draft
    ? {
        ...draft,
        services: parseList(draftText.services),
        languages: parseList(draftText.languages),
        postal_codes: parseList(draftText.postal_codes, 12),
        sources: parseList(draftText.sources),
      }
    : null;

  async function onSaveRule() {
    if (!effectiveDraft) return;
    const errors = validateRule(effectiveDraft);
    if (errors.length) return toast(errors[0], 'error');
    setSaving(true);
    try {
      await saveRule(ownerId as string, effectiveDraft, previousPool);
      toast('Rule saved', 'success');
      setDraft(null);
      await loadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the rule.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function onMove(index: number, delta: number) {
    const next = moveInList(rules, index, index + delta);
    if (next === rules || next.every((r, i) => r.id === rules[i].id)) return;
    setRules(next);
    try {
      await reorderRules(next.map((r) => r.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reorder the rules.', 'error');
      await loadAll();
    }
  }

  async function onToggleRule(rule: AssignmentRule) {
    try {
      await saveRule(ownerId as string, { ...rule, is_active: !rule.is_active }, rule.agent_ids);
      setRules((list) => list.map((r) => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the rule.', 'error');
    }
  }

  async function onDeleteRule() {
    if (!toDelete) return;
    try {
      await deleteRule(toDelete.id);
      setRules((list) => list.filter((r) => r.id !== toDelete.id));
      toast('Rule deleted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the rule.', 'error');
    } finally {
      setToDelete(null);
    }
  }

  async function onProbe() {
    setProbing(true);
    try {
      setProbeResult(await previewAssignment(probe));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Preview failed.', 'error');
    } finally {
      setProbing(false);
    }
  }

  const setNum = (key: 'first_touch_sla_minutes' | 'reassign_after_minutes' | 'max_reassignments') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: e.target.value === '' ? NaN : Number(e.target.value) }));

  return (
    <DashboardLayout activeLabel={PAGE_LABEL}>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">Lead assignment</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Route every new lead to the right CSR automatically, hold agents to a first-touch SLA, and see who converts.
          </p>
        </header>

        <div role="tablist" aria-label="Lead assignment sections" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.key ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'settings' && (
          <Card>
            <div className="space-y-6">
              <Toggle checked={settings.enabled} onChange={(v) => setSettings((s) => ({ ...s, enabled: v }))} label="Automatically assign new leads" />
              <div>
                <label htmlFor="la-fallback" className="mb-1.5 block text-sm font-medium text-text-primary">Default pool strategy</label>
                <select
                  id="la-fallback"
                  className={selectClass}
                  value={settings.fallback_strategy}
                  onChange={(e) => setSettings((s) => ({ ...s, fallback_strategy: e.target.value as AssignmentStrategy }))}
                >
                  {Object.entries(STRATEGY_META).map(([k, m]) => (
                    <option key={k} value={k}>{m.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-text-secondary">
                  Used when no rule matches. {STRATEGY_META[settings.fallback_strategy].description}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Input id="la-sla" type="number" min={1} label="First-touch SLA (minutes)" helperText="Time an agent has to touch a lead."
                  value={Number.isNaN(settings.first_touch_sla_minutes) ? '' : settings.first_touch_sla_minutes} onChange={setNum('first_touch_sla_minutes')} />
                <Input id="la-reassign" type="number" min={1} label="Auto-reassign after (minutes)" helperText="Untouched leads move to another agent."
                  value={Number.isNaN(settings.reassign_after_minutes) ? '' : settings.reassign_after_minutes} onChange={setNum('reassign_after_minutes')} />
                <Input id="la-max" type="number" min={0} max={10} label="Max reassignments" helperText="Then the lead is escalated."
                  value={Number.isNaN(settings.max_reassignments) ? '' : settings.max_reassignments} onChange={setNum('max_reassignments')} />
              </div>
              <Toggle checked={settings.escalate_on_exhausted} onChange={(v) => setSettings((s) => ({ ...s, escalate_on_exhausted: v }))}
                label="Escalate through the on-call schedule when nobody contacts the lead" />
              <Toggle checked={settings.reassign_manual_assignments} onChange={(v) => setSettings((s) => ({ ...s, reassign_manual_assignments: v }))}
                label="Also auto-reassign leads that were assigned manually" />
              <p className="text-xs text-text-secondary">
                A lead counts as touched when its assigned agent changes the stage, notes, quote or follow-up. Automated replies never count.
                Enabling this also assigns unassigned open leads created in the last 48 hours.
              </p>
              <Button onClick={onSaveSettings} disabled={saving}>
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save settings
              </Button>
            </div>
          </Card>
        )}

        {tab === 'rules' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">Rules run top to bottom; the first rule with an available agent wins.</p>
              <Button onClick={() => openEditor()} disabled={!!draft}><Plus size={16} /> New rule</Button>
            </div>

            {effectiveDraft && draft && (
              <Card>
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-text-primary">{draft.id ? 'Edit rule' : 'New rule'}</h2>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input id="rule-name" label="Name" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    <div>
                      <label htmlFor="rule-strategy" className="mb-1.5 block text-sm font-medium text-text-primary">Strategy</label>
                      <select id="rule-strategy" className={selectClass} value={draft.strategy}
                        onChange={(e) => setDraft({ ...draft, strategy: e.target.value as AssignmentStrategy })}>
                        {Object.entries(STRATEGY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                      </select>
                    </div>
                    <Input id="rule-services" label="Services" helperText="Comma separated, e.g. HVAC, water heater" value={draftText.services}
                      onChange={(e) => setDraftText({ ...draftText, services: e.target.value })} />
                    <Input id="rule-languages" label="Languages" helperText="Agents must speak one of these" value={draftText.languages}
                      onChange={(e) => setDraftText({ ...draftText, languages: e.target.value })} />
                    <Input id="rule-zips" label="ZIP / postal codes" helperText="US ZIP, or Canadian FSA like M5V" value={draftText.postal_codes}
                      onChange={(e) => setDraftText({ ...draftText, postal_codes: e.target.value })} />
                    <Input id="rule-sources" label="Lead sources" helperText="e.g. angi, google_lsa, website" value={draftText.sources}
                      onChange={(e) => setDraftText({ ...draftText, sources: e.target.value })} />
                  </div>

                  {areas.length > 0 && (
                    <fieldset>
                      <legend className="mb-1.5 text-sm font-medium text-text-primary">Service-area zones</legend>
                      <div className="flex flex-wrap gap-3">
                        {areas.map((a) => (
                          <Toggle key={a.id} label={a.name} checked={draft.service_area_ids.includes(a.id)}
                            onChange={(v) => setDraft({ ...draft, service_area_ids: v ? [...draft.service_area_ids, a.id] : draft.service_area_ids.filter((id) => id !== a.id) })} />
                        ))}
                      </div>
                    </fieldset>
                  )}

                  <fieldset>
                    <legend className="mb-1.5 text-sm font-medium text-text-primary">Agent pool</legend>
                    {enrolled.length === 0 ? (
                      <p className="text-sm text-text-secondary">Enrol agents on the Agents tab first.</p>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {enrolled.map((a) => (
                          <Toggle key={a.team_member_id} label={a.name} checked={draft.agent_ids.includes(a.team_member_id)}
                            onChange={(v) => setDraft({ ...draft, agent_ids: v ? [...draft.agent_ids, a.team_member_id] : draft.agent_ids.filter((id) => id !== a.team_member_id) })} />
                        ))}
                      </div>
                    )}
                    <p className="mt-1.5 text-xs text-text-secondary">Leave empty to use every enrolled agent.</p>
                  </fieldset>

                  <Toggle label="Rule is active" checked={draft.is_active} onChange={(v) => setDraft({ ...draft, is_active: v })} />

                  {ruleWarnings(effectiveDraft, agents).map((w) => (
                    <p key={w} className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary" role="status">{w}</p>
                  ))}

                  <div className="flex gap-3">
                    <Button onClick={onSaveRule} disabled={saving}>
                      {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save rule
                    </Button>
                    <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                  </div>
                </div>
              </Card>
            )}

            {rules.length === 0 && !draft ? (
              <EmptyState icon={GitBranch} title="No rules yet" description="Without rules, leads go to the default pool. Add a rule to route by service, area, language or source."
                action={{ label: 'Create a rule', onClick: () => openEditor() }} />
            ) : (
              rules.map((rule, i) => (
                <Card key={rule.id} className="!p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="w-8 text-center text-sm font-semibold text-text-secondary">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-text-primary">{rule.name}{!rule.is_active && <span className="ml-2 text-xs text-text-secondary">(paused)</span>}</p>
                      <p className="text-sm text-text-secondary">{describeRule(rule, areaNames)}</p>
                      <p className="text-xs text-text-secondary">
                        {STRATEGY_META[rule.strategy].label} → {rule.agent_ids.length ? rule.agent_ids.map((id) => agentNames[id] ?? '—').join(', ') : 'all enrolled agents'}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" aria-label="Move up" disabled={i === 0} onClick={() => onMove(i, -1)}><ArrowUp size={16} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => onMove(i, 1)}><ArrowDown size={16} /></Button>
                    <Button variant="secondary" size="sm" onClick={() => onToggleRule(rule)}>{rule.is_active ? 'Pause' : 'Resume'}</Button>
                    <Button variant="secondary" size="sm" aria-label="Edit rule" onClick={() => openEditor(rule)}><Pencil size={16} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Delete rule" onClick={() => setToDelete(rule)}><Trash2 size={16} /></Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === 'agents' && (
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-text-primary">Agents</h2>
            <p className="mb-4 text-sm text-text-secondary">Only enrolled team members receive leads. Languages come from the Team page.</p>
            {agents.length === 0 ? (
              <EmptyState icon={Users} title="No team members yet" description="Invite your CSRs from the Team page, then enrol them here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-text-secondary">
                    <tr><th className="py-2 pr-4">Agent</th><th className="pr-4">Languages</th><th className="pr-4">Open leads</th><th className="pr-4">Capacity</th><th className="pr-4">Receiving</th><th /></tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.team_member_id} className="border-t border-border">
                        <td className="py-3 pr-4"><p className="font-medium text-text-primary">{a.name}</p><p className="text-xs text-text-secondary">{a.role}</p></td>
                        <td className="pr-4 text-text-secondary">{a.languages.join(', ') || '—'}</td>
                        <td className="pr-4 text-text-primary">{a.enrolled ? openByAgent[a.team_member_id] ?? 0 : '—'}</td>
                        <td className="pr-4">
                          {a.enrolled ? (
                            <input aria-label={`Capacity for ${a.name}`} type="number" min={1} max={1000} defaultValue={a.max_open_leads}
                              className="focus-ring w-20 rounded-lg border border-border bg-bg-primary px-2 py-1 text-text-primary"
                              onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (v !== a.max_open_leads) void onToggleAgent(a, { max_open_leads: v });
                              }} />
                          ) : '—'}
                        </td>
                        <td className="pr-4">
                          {a.enrolled ? <Toggle label="" checked={a.accepts_leads} onChange={(v) => onToggleAgent(a, { accepts_leads: v })} /> : '—'}
                        </td>
                        <td className="text-right">
                          {a.enrolled
                            ? <Button variant="ghost" size="sm" onClick={() => onUnenrol(a)}>Remove</Button>
                            : <Button variant="secondary" size="sm" onClick={() => onToggleAgent(a, { accepts_leads: true, max_open_leads: a.max_open_leads })}>Enrol</Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === 'performance' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <label htmlFor="la-days" className="text-sm text-text-secondary">Leads created in the last</label>
              <select id="la-days" className={`${selectClass} !w-auto`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Assigned" value={String(totals.assigned)} />
              <Stat label="Won" value={String(totals.won)} hint={`${totals.conversionRate}% conversion`} />
              <Stat label="SLA breaches" value={String(totals.slaBreaches)} />
              <Stat label="Top converter" value={totals.topAgent ?? '—'} hint="min. 5 leads" />
            </div>
            <Card>
              {report.length === 0 ? (
                <EmptyState icon={Users} title="Nothing to report" description="Stats appear once leads are assigned to agents." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase text-text-secondary">
                      <tr>
                        <th className="py-2 pr-4">Agent</th><th className="pr-4">Assigned</th><th className="pr-4">Touched</th><th className="pr-4">Won</th>
                        <th className="pr-4">Conversion</th><th className="pr-4">Avg first touch</th><th className="pr-4">SLA breaches</th>
                        <th className="pr-4">Moved away</th><th className="pr-4">Open now</th><th>Won value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.map((r) => (
                        <tr key={r.member_id ?? 'unassigned'} className="border-t border-border text-text-primary">
                          <td className="py-3 pr-4 font-medium">{r.member_name}</td>
                          <td className="pr-4">{r.leads_assigned}</td>
                          <td className="pr-4">{r.leads_touched}</td>
                          <td className="pr-4">{r.leads_won}</td>
                          <td className="pr-4">{r.member_id ? `${r.conversion_rate}%` : '—'}</td>
                          <td className="pr-4">{formatMinutes(r.avg_first_touch_minutes)}</td>
                          <td className="pr-4">{r.sla_breaches}</td>
                          <td className="pr-4">{r.reassigned_away}</td>
                          <td className="pr-4">{r.open_leads}</td>
                          <td>{r.won_value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'test' && (
          <div className="space-y-4">
            <Card>
              <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-text-primary"><FlaskConical size={18} /> Rule tester</h2>
              <p className="mb-4 text-sm text-text-secondary">See who a lead with these details would be assigned to right now. Nothing is changed.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input id="probe-service" label="Service" value={probe.service} onChange={(e) => setProbe({ ...probe, service: e.target.value })} />
                <Input id="probe-postal" label="ZIP / postal code" value={probe.postal} onChange={(e) => setProbe({ ...probe, postal: e.target.value })} />
                <Input id="probe-language" label="Language" value={probe.language} onChange={(e) => setProbe({ ...probe, language: e.target.value })} />
                <Input id="probe-source" label="Lead source" value={probe.source} onChange={(e) => setProbe({ ...probe, source: e.target.value })} />
              </div>
              <div className="mt-4 flex items-center gap-4">
                <Button onClick={onProbe} disabled={probing}>{probing && <Loader2 size={16} className="animate-spin" />} Test</Button>
                {probeResult && (
                  <p className="text-sm text-text-primary" role="status">
                    {probeResult.matched
                      ? `${probeResult.member_name ?? 'Agent'} · ${probeResult.rule_name ?? 'default pool'} (${methodLabel(probeResult.method)})`
                      : 'No agent is available for this lead.'}
                  </p>
                )}
              </div>
            </Card>
            <Card>
              <h2 className="mb-3 text-lg font-semibold text-text-primary">Recent activity</h2>
              {events.length === 0 ? (
                <EmptyState icon={GitBranch} title="No activity" description="Assignments, SLA breaches and escalations are logged here." />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <span className="text-text-primary">
                        <strong>{eventLabel(e.event_type)}</strong> · {e.lead_name ?? 'Lead'}
                        {e.to_member_id && <> → {agentNames[e.to_member_id] ?? 'agent'}</>}
                      </span>
                      <span className="text-xs text-text-secondary">{methodLabel(e.method)} · {new Date(e.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this rule?"
        description={`“${toDelete?.name ?? ''}” will stop routing leads. Past assignments are kept.`}
        confirmLabel="Delete rule"
        onConfirm={onDeleteRule}
        onCancel={() => setToDelete(null)}
      />
    </DashboardLayout>
  );
}
