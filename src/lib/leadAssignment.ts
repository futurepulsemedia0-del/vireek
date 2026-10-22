import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Lead assignment rules — client library.
// The engine itself lives in Postgres (migration 20271021000000_lead_assignment_rules.sql);
// this file holds the types, the pure helpers (unit-tested) and the thin API layer.
// ---------------------------------------------------------------------------

export type AssignmentStrategy = 'round_robin' | 'load_balanced';

export const STRATEGY_META: Record<AssignmentStrategy, { label: string; description: string }> = {
  round_robin: {
    label: 'Round robin',
    description: 'Each new lead goes to the agent who was assigned a lead the longest time ago.',
  },
  load_balanced: {
    label: 'Load balanced',
    description: 'Each new lead goes to the agent with the fewest open leads right now.',
  },
};

export const LIMITS = {
  nameMax: 120,
  listItemMax: 80,
  maxServices: 50,
  maxLanguages: 20,
  maxPostalCodes: 2000,
  maxServiceAreas: 100,
  maxSources: 30,
  priorityMin: 1,
  priorityMax: 10000,
  slaMin: 1,
  slaMax: 1440,
  reassignMax: 2880,
  maxReassignmentsMax: 10,
  capacityMin: 1,
  capacityMax: 1000,
} as const;

export interface AssignmentSettings {
  enabled: boolean;
  fallback_strategy: AssignmentStrategy;
  first_touch_sla_minutes: number;
  reassign_after_minutes: number;
  max_reassignments: number;
  reassign_manual_assignments: boolean;
  escalate_on_exhausted: boolean;
}

export const DEFAULT_SETTINGS: AssignmentSettings = {
  enabled: false,
  fallback_strategy: 'round_robin',
  first_touch_sla_minutes: 5,
  reassign_after_minutes: 15,
  max_reassignments: 3,
  reassign_manual_assignments: false,
  escalate_on_exhausted: true,
};

export interface AssignmentAgent {
  team_member_id: string;
  name: string;
  email: string;
  role: string;
  languages: string[];
  enrolled: boolean;
  accepts_leads: boolean;
  max_open_leads: number;
}

export interface AssignmentRule {
  id: string;
  name: string;
  priority: number;
  is_active: boolean;
  strategy: AssignmentStrategy;
  services: string[];
  languages: string[];
  postal_codes: string[];
  service_area_ids: string[];
  sources: string[];
  agent_ids: string[];
}

export type RuleDraft = Omit<AssignmentRule, 'id'> & { id?: string };

export interface ServiceAreaOption {
  id: string;
  name: string;
  is_active: boolean;
}

export interface AgentReportRow {
  member_id: string | null;
  member_name: string;
  leads_assigned: number;
  leads_touched: number;
  leads_won: number;
  conversion_rate: number;
  avg_first_touch_minutes: number | null;
  sla_breaches: number;
  reassigned_away: number;
  open_leads: number;
  won_value: number;
}

export interface PreviewInput {
  service?: string;
  postal?: string;
  language?: string;
  source?: string;
}

export interface PreviewResult {
  matched: boolean;
  member_id?: string;
  member_name?: string | null;
  rule_id?: string | null;
  rule_name?: string | null;
  method?: string;
}

export interface AssignmentEvent {
  id: string;
  lead_id: string;
  lead_name: string | null;
  event_type: string;
  from_member_id: string | null;
  to_member_id: string | null;
  method: string | null;
  created_at: string;
}

export const EMPTY_RULE: RuleDraft = {
  name: '',
  priority: 100,
  is_active: true,
  strategy: 'round_robin',
  services: [],
  languages: [],
  postal_codes: [],
  service_area_ids: [],
  sources: [],
  agent_ids: [],
};

// ------------------------------- pure helpers -------------------------------

/** "a, b;  A\nc" -> ["a", "b", "c"] (trimmed, de-duplicated case-insensitively, order kept). */
export function parseList(text: string, itemMax: number = LIMITS.listItemMax): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const item = raw.trim().slice(0, itemMax);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function formatList(items: string[]): string {
  return items.join(', ');
}

export function validateSettings(s: AssignmentSettings): string[] {
  const errors: string[] = [];
  const int = (n: number) => Number.isInteger(n);
  if (!int(s.first_touch_sla_minutes) || s.first_touch_sla_minutes < LIMITS.slaMin || s.first_touch_sla_minutes > LIMITS.slaMax) {
    errors.push(`First-touch SLA must be a whole number between ${LIMITS.slaMin} and ${LIMITS.slaMax} minutes.`);
  }
  if (!int(s.reassign_after_minutes) || s.reassign_after_minutes < LIMITS.slaMin || s.reassign_after_minutes > LIMITS.reassignMax) {
    errors.push(`Auto-reassign time must be a whole number between ${LIMITS.slaMin} and ${LIMITS.reassignMax} minutes.`);
  }
  if (int(s.first_touch_sla_minutes) && int(s.reassign_after_minutes) && s.reassign_after_minutes < s.first_touch_sla_minutes) {
    errors.push('Auto-reassign time cannot be shorter than the first-touch SLA.');
  }
  if (!int(s.max_reassignments) || s.max_reassignments < 0 || s.max_reassignments > LIMITS.maxReassignmentsMax) {
    errors.push(`Maximum reassignments must be between 0 and ${LIMITS.maxReassignmentsMax}.`);
  }
  return errors;
}

export function validateRule(draft: RuleDraft): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (!name) errors.push('Give the rule a name.');
  if (name.length > LIMITS.nameMax) errors.push(`Rule name must be at most ${LIMITS.nameMax} characters.`);
  if (!Number.isInteger(draft.priority) || draft.priority < LIMITS.priorityMin || draft.priority > LIMITS.priorityMax) {
    errors.push(`Priority must be a whole number between ${LIMITS.priorityMin} and ${LIMITS.priorityMax}.`);
  }
  if (draft.services.length > LIMITS.maxServices) errors.push(`At most ${LIMITS.maxServices} services per rule.`);
  if (draft.languages.length > LIMITS.maxLanguages) errors.push(`At most ${LIMITS.maxLanguages} languages per rule.`);
  if (draft.postal_codes.length > LIMITS.maxPostalCodes) errors.push(`At most ${LIMITS.maxPostalCodes} ZIP / postal codes per rule.`);
  if (draft.service_area_ids.length > LIMITS.maxServiceAreas) errors.push(`At most ${LIMITS.maxServiceAreas} zones per rule.`);
  if (draft.sources.length > LIMITS.maxSources) errors.push(`At most ${LIMITS.maxSources} lead sources per rule.`);
  return errors;
}

/** Non-blocking hints shown next to the editor. */
export function ruleWarnings(draft: RuleDraft, agents: AssignmentAgent[]): string[] {
  const warnings: string[] = [];
  const hasCriteria =
    draft.services.length + draft.languages.length + draft.postal_codes.length + draft.service_area_ids.length + draft.sources.length > 0;
  if (!hasCriteria) warnings.push('This rule has no criteria, so it matches every lead that reaches it.');
  const enrolled = new Map(agents.filter((a) => a.enrolled).map((a) => [a.team_member_id, a]));
  if (draft.agent_ids.some((id) => !enrolled.has(id))) {
    warnings.push('Some selected agents are not enrolled in lead assignment and will be ignored.');
  }
  if (draft.languages.length > 0) {
    const pool = draft.agent_ids.length > 0 ? draft.agent_ids.map((id) => enrolled.get(id)).filter(Boolean) : [...enrolled.values()];
    const wanted = draft.languages.map((l) => l.toLowerCase());
    const covered = (pool as AssignmentAgent[]).some((a) => a.languages.some((l) => wanted.includes(l.trim().toLowerCase())));
    if (!covered) warnings.push('No agent in this pool speaks the selected language(s) — the rule will never assign a lead.');
  }
  return warnings;
}

export function describeRule(rule: RuleDraft, areaNames: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (rule.services.length) parts.push(`service: ${rule.services.join(' / ')}`);
  if (rule.service_area_ids.length || rule.postal_codes.length) {
    const zones = rule.service_area_ids.map((id) => areaNames[id] ?? 'zone');
    const codes = rule.postal_codes.length > 6 ? `${rule.postal_codes.slice(0, 6).join(', ')} +${rule.postal_codes.length - 6}` : rule.postal_codes.join(', ');
    parts.push(`area: ${[...zones, codes].filter(Boolean).join(', ')}`);
  }
  if (rule.languages.length) parts.push(`language: ${rule.languages.join(' / ')}`);
  if (rule.sources.length) parts.push(`source: ${rule.sources.join(' / ')}`);
  return parts.length ? parts.join(' · ') : 'All leads';
}

/** Diff a rule's agent pool so the round-robin cursor of unchanged agents is preserved. */
export function diffPool(current: string[], next: string[]): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  return {
    add: [...nxt].filter((id) => !cur.has(id)),
    remove: [...cur].filter((id) => !nxt.has(id)),
  };
}

/** Sequential priorities (10, 20, 30, …) in the given order. */
export function priorityPlan(orderedIds: string[]): { id: string; priority: number }[] {
  return orderedIds.map((id, i) => ({ id, priority: (i + 1) * 10 }));
}

export function moveInList<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items.slice();
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '<1m';
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface ReportTotals {
  assigned: number;
  touched: number;
  won: number;
  conversionRate: number;
  slaBreaches: number;
  wonValue: number;
  topAgent: string | null;
}

/** Totals over real agents (the "Unassigned" row has member_id = null and is excluded from ranking). */
export function summarizeReport(rows: AgentReportRow[], minLeadsForRanking = 5): ReportTotals {
  const agents = rows.filter((r) => r.member_id !== null);
  const assigned = agents.reduce((n, r) => n + r.leads_assigned, 0);
  const won = agents.reduce((n, r) => n + r.leads_won, 0);
  const ranked = agents
    .filter((r) => r.leads_assigned >= minLeadsForRanking)
    .sort((a, b) => b.conversion_rate - a.conversion_rate || b.leads_won - a.leads_won);
  return {
    assigned,
    touched: agents.reduce((n, r) => n + r.leads_touched, 0),
    won,
    conversionRate: assigned === 0 ? 0 : Math.round((won / assigned) * 1000) / 10,
    slaBreaches: agents.reduce((n, r) => n + r.sla_breaches, 0),
    wonValue: agents.reduce((n, r) => n + r.won_value, 0),
    topAgent: ranked[0]?.member_name ?? null,
  };
}

export function rangeForDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

const METHOD_LABELS: Record<string, string> = {
  rule_round_robin: 'Rule · round robin',
  rule_load_balanced: 'Rule · load balanced',
  default_round_robin: 'Default pool · round robin',
  default_load_balanced: 'Default pool · load balanced',
  manual: 'Manual',
  escalation: 'Accepted escalation',
};

export function methodLabel(method: string | null | undefined): string {
  if (!method) return '—';
  return METHOD_LABELS[method] ?? method;
}

const EVENT_LABELS: Record<string, string> = {
  assigned: 'Assigned',
  reassigned: 'Auto-reassigned',
  manual: 'Manually assigned',
  escalation_accepted: 'Escalation accepted',
  unassigned: 'No agent available',
  sla_breach: 'SLA breached',
  escalated: 'Escalated',
  touched: 'First touch',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

// ---------------------------------- API ------------------------------------

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function fetchSettings(): Promise<AssignmentSettings> {
  const { data, error } = await supabase.from('lead_assignment_settings').select('*').maybeSingle();
  if (error) fail(error, 'Could not load settings.');
  return { ...DEFAULT_SETTINGS, ...(data ?? {}) } as AssignmentSettings;
}

export async function saveSettings(ownerId: string, settings: AssignmentSettings): Promise<void> {
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors[0]);
  const { error } = await supabase
    .from('lead_assignment_settings')
    .upsert({ user_id: ownerId, ...settings }, { onConflict: 'user_id' });
  if (error) fail(error, 'Could not save settings.');
}

export async function fetchAgents(ownerId: string): Promise<AssignmentAgent[]> {
  const [members, profiles] = await Promise.all([
    supabase
      .from('team_members')
      .select('id, member_name, member_email, role, languages, invite_status')
      .eq('account_owner_id', ownerId)
      .in('invite_status', ['active', 'accepted'])
      .order('member_name', { ascending: true }),
    supabase.from('lead_assignment_agents').select('team_member_id, accepts_leads, max_open_leads'),
  ]);
  if (members.error) fail(members.error, 'Could not load team members.');
  if (profiles.error) fail(profiles.error, 'Could not load agents.');
  type AgentProfileRow = { team_member_id: string; accepts_leads: boolean; max_open_leads: number };
  const byId = new Map(((profiles.data ?? []) as AgentProfileRow[]).map((p) => [p.team_member_id, p] as const));
  return ((members.data ?? []) as Array<Record<string, unknown>>).map((m) => {
    const p = byId.get(m.id as string);
    return {
      team_member_id: m.id as string,
      name: (m.member_name as string | null)?.trim() || (m.member_email as string),
      email: m.member_email as string,
      role: m.role as string,
      languages: (m.languages as string[] | null) ?? [],
      enrolled: Boolean(p),
      accepts_leads: p ? Boolean(p.accepts_leads) : false,
      max_open_leads: p ? Number(p.max_open_leads) : 25,
    };
  });
}

export async function saveAgent(
  ownerId: string,
  teamMemberId: string,
  patch: { accepts_leads: boolean; max_open_leads: number },
): Promise<void> {
  if (!Number.isInteger(patch.max_open_leads) || patch.max_open_leads < LIMITS.capacityMin || patch.max_open_leads > LIMITS.capacityMax) {
    throw new Error(`Capacity must be a whole number between ${LIMITS.capacityMin} and ${LIMITS.capacityMax}.`);
  }
  const { error } = await supabase
    .from('lead_assignment_agents')
    .upsert({ team_member_id: teamMemberId, user_id: ownerId, ...patch }, { onConflict: 'team_member_id' });
  if (error) fail(error, 'Could not save the agent.');
}

export async function removeAgent(teamMemberId: string): Promise<void> {
  const { error } = await supabase.from('lead_assignment_agents').delete().eq('team_member_id', teamMemberId);
  if (error) fail(error, 'Could not remove the agent.');
}

export async function fetchRules(): Promise<AssignmentRule[]> {
  const [rules, pool] = await Promise.all([
    supabase.from('lead_assignment_rules').select('*').order('priority', { ascending: true }).order('created_at', { ascending: true }),
    supabase.from('lead_assignment_rule_agents').select('rule_id, team_member_id'),
  ]);
  if (rules.error) fail(rules.error, 'Could not load rules.');
  if (pool.error) fail(pool.error, 'Could not load rule pools.');
  const agentsByRule = new Map<string, string[]>();
  for (const row of (pool.data ?? []) as Array<Record<string, unknown>>) {
    const list = agentsByRule.get(row.rule_id as string) ?? [];
    list.push(row.team_member_id as string);
    agentsByRule.set(row.rule_id as string, list);
  }
  return ((rules.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    priority: r.priority as number,
    is_active: r.is_active as boolean,
    strategy: r.strategy as AssignmentStrategy,
    services: (r.services as string[]) ?? [],
    languages: (r.languages as string[]) ?? [],
    postal_codes: (r.postal_codes as string[]) ?? [],
    service_area_ids: (r.service_area_ids as string[]) ?? [],
    sources: (r.sources as string[]) ?? [],
    agent_ids: agentsByRule.get(r.id as string) ?? [],
  }));
}

export async function saveRule(ownerId: string, draft: RuleDraft, previousAgentIds: string[] = []): Promise<string> {
  const errors = validateRule(draft);
  if (errors.length) throw new Error(errors[0]);
  const body = {
    name: draft.name.trim(),
    priority: draft.priority,
    is_active: draft.is_active,
    strategy: draft.strategy,
    services: draft.services,
    languages: draft.languages,
    postal_codes: draft.postal_codes,
    service_area_ids: draft.service_area_ids,
    sources: draft.sources,
  };

  let ruleId = draft.id;
  if (ruleId) {
    const { error } = await supabase.from('lead_assignment_rules').update(body).eq('id', ruleId);
    if (error) fail(error, 'Could not update the rule.');
  } else {
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .insert({ user_id: ownerId, ...body })
      .select('id')
      .single();
    if (error || !data) fail(error, 'Could not create the rule.');
    ruleId = data.id as string;
  }

  const { add, remove } = diffPool(previousAgentIds, draft.agent_ids);
  if (remove.length) {
    const { error } = await supabase.from('lead_assignment_rule_agents').delete().eq('rule_id', ruleId).in('team_member_id', remove);
    if (error) fail(error, 'The rule was saved but its agent pool could not be updated.');
  }
  if (add.length) {
    const { error } = await supabase
      .from('lead_assignment_rule_agents')
      .insert(add.map((team_member_id) => ({ rule_id: ruleId, team_member_id })));
    if (error) fail(error, 'The rule was saved but its agent pool could not be updated.');
  }
  return ruleId as string;
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('lead_assignment_rules').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the rule.');
}

export async function reorderRules(orderedIds: string[]): Promise<void> {
  const results = await Promise.all(
    priorityPlan(orderedIds).map(({ id, priority }) => supabase.from('lead_assignment_rules').update({ priority }).eq('id', id)),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) fail(failed.error, 'Could not reorder the rules.');
}

export async function fetchServiceAreas(): Promise<ServiceAreaOption[]> {
  const { data, error } = await supabase.from('service_areas').select('id, name, is_active').order('name', { ascending: true });
  if (error) fail(error, 'Could not load service areas.');
  return (data ?? []) as ServiceAreaOption[];
}

export async function previewAssignment(input: PreviewInput): Promise<PreviewResult> {
  const { data, error } = await supabase.rpc('lead_assignment_preview', {
    p_service: input.service?.trim() || null,
    p_postal: input.postal?.trim() || null,
    p_language: input.language?.trim() || null,
    p_source: input.source?.trim() || null,
  });
  if (error) fail(error, 'Preview failed.');
  return (data ?? { matched: false }) as PreviewResult;
}

export async function fetchAgentReport(from: string, to: string): Promise<AgentReportRow[]> {
  const { data, error } = await supabase.rpc('lead_assignment_agent_report', { p_from: from, p_to: to });
  if (error) fail(error, 'Could not load the report.');
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    member_id: (r.member_id as string | null) ?? null,
    member_name: String(r.member_name ?? ''),
    leads_assigned: Number(r.leads_assigned ?? 0),
    leads_touched: Number(r.leads_touched ?? 0),
    leads_won: Number(r.leads_won ?? 0),
    conversion_rate: Number(r.conversion_rate ?? 0),
    avg_first_touch_minutes: r.avg_first_touch_minutes == null ? null : Number(r.avg_first_touch_minutes),
    sla_breaches: Number(r.sla_breaches ?? 0),
    reassigned_away: Number(r.reassigned_away ?? 0),
    open_leads: Number(r.open_leads ?? 0),
    won_value: Number(r.won_value ?? 0),
  }));
}

export async function fetchRecentEvents(limit = 40): Promise<AssignmentEvent[]> {
  const { data, error } = await supabase
    .from('lead_assignment_events')
    .select('id, lead_id, event_type, from_member_id, to_member_id, method, created_at, leads(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load activity.');
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((e) => {
    const lead = e.leads as { name?: string } | { name?: string }[] | null;
    const leadName = Array.isArray(lead) ? lead[0]?.name : lead?.name;
    return {
      id: e.id as string,
      lead_id: e.lead_id as string,
      lead_name: leadName ?? null,
      event_type: e.event_type as string,
      from_member_id: (e.from_member_id as string | null) ?? null,
      to_member_id: (e.to_member_id as string | null) ?? null,
      method: (e.method as string | null) ?? null,
      created_at: e.created_at as string,
    };
  });
}

/** Account owner id = the owner's profile id, also for team members. */
export function resolveOwnerId(user: { id: string } | null, teamMember: { account_owner_id: string } | null): string | null {
  return teamMember?.account_owner_id ?? user?.id ?? null;
}
