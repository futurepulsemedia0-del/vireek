import { supabase } from '@/lib/supabase';
import {
  buildRollup,
  dollarsToCents,
  friendlyError,
  templateFor,
  todayIso,
  type InstallProject,
  type InvoiceLite,
  type MaterialStatus,
  type MilestoneKind,
  type MilestoneStatus,
  type PhaseStatus,
  type ProjectBilling,
  type ProjectFormValues,
  type ProjectMaterial,
  type ProjectMilestone,
  type ProjectPhase,
  type ProjectRollup,
  type ProjectStatus,
} from '@/lib/installProjects';

// Install Projects data layer. Every query is scoped to the account owner
// (`user_id = accountOwnerId`) on top of the RLS policies, so a team member
// and the owner always see the same account — and nothing else.

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(friendlyError(res.error, fallback));
  return res.data as T;
}

const PAGE = 1000;
const MAX_ROWS = 20_000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<Res<T[]>>, fallback: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; out.length < MAX_ROWS; from += PAGE) {
    const rows = unwrap(await build(from, from + PAGE - 1), fallback) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchInvoicesById(ownerId: string, ids: string[]): Promise<Record<string, InvoiceLite>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const map: Record<string, InvoiceLite> = {};
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const rows = unwrap(
      (await supabase.from('invoices').select('id, invoice_number, status, due_date').eq('user_id', ownerId).in('id', chunk)) as Res<InvoiceLite[]>,
      'Could not load invoices.',
    );
    for (const r of rows ?? []) map[r.id] = r;
  }
  return map;
}

// ------------------------------------------------------------------
// Portfolio
// ------------------------------------------------------------------

export interface Portfolio {
  projects: InstallProject[];
  rollups: Record<string, ProjectRollup>;
}

export async function fetchPortfolio(ownerId: string): Promise<Portfolio> {
  const [projects, phases, milestones, billing] = await Promise.all([
    fetchAll<InstallProject>(
      (a, b) => supabase.from('install_projects').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }).order('id').range(a, b) as unknown as PromiseLike<Res<InstallProject[]>>,
      'Could not load projects.',
    ),
    fetchAll<ProjectPhase>(
      (a, b) => supabase.from('install_project_phases').select('*').eq('user_id', ownerId).order('id').range(a, b) as unknown as PromiseLike<Res<ProjectPhase[]>>,
      'Could not load phases.',
    ),
    fetchAll<ProjectMilestone>(
      (a, b) => supabase.from('install_project_milestones').select('*').eq('user_id', ownerId).order('id').range(a, b) as unknown as PromiseLike<Res<ProjectMilestone[]>>,
      'Could not load milestones.',
    ),
    fetchAll<ProjectBilling>(
      (a, b) => supabase.from('install_project_billing').select('*').eq('user_id', ownerId).order('id').range(a, b) as unknown as PromiseLike<Res<ProjectBilling[]>>,
      'Could not load billing.',
    ),
  ]);

  const invoices = await fetchInvoicesById(ownerId, [
    ...billing.map((b) => b.invoice_id ?? ''),
    ...projects.map((p) => p.retainage_invoice_id ?? ''),
  ]);

  const today = todayIso();
  const group = <T extends { project_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.project_id) ?? m.set(r.project_id, []).get(r.project_id)!).push(r);
    return m;
  };
  const ph = group(phases);
  const ms = group(milestones);
  const bl = group(billing);

  const rollups: Record<string, ProjectRollup> = {};
  for (const p of projects) {
    rollups[p.id] = buildRollup(p, ph.get(p.id) ?? [], ms.get(p.id) ?? [], bl.get(p.id) ?? [], invoices, today);
  }
  return { projects, rollups };
}

// ------------------------------------------------------------------
// Project bundle (detail view)
// ------------------------------------------------------------------

export interface LinkedJob {
  link_id: string;
  job_id: string;
  phase_id: string | null;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  job_status: string;
}

export interface ProjectBundle {
  project: InstallProject;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  billing: ProjectBilling[];
  materials: ProjectMaterial[];
  jobs: LinkedJob[];
  invoices: Record<string, InvoiceLite>;
}

interface JobLinkRow {
  id: string;
  job_id: string;
  phase_id: string | null;
}

interface JobRow {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  job_status: string;
}

export async function fetchProjectBundle(ownerId: string, projectId: string): Promise<ProjectBundle | null> {
  const scoped = (table: string) => supabase.from(table).select('*').eq('user_id', ownerId).eq('project_id', projectId);
  const [project, phases, milestones, billing, materials, links] = await Promise.all([
    supabase.from('install_projects').select('*').eq('user_id', ownerId).eq('id', projectId).maybeSingle(),
    scoped('install_project_phases').order('sort_order').order('created_at'),
    scoped('install_project_milestones').order('sort_order').order('created_at'),
    scoped('install_project_billing').order('sort_order').order('created_at'),
    scoped('install_project_materials').order('created_at'),
    scoped('install_project_jobs').order('created_at'),
  ]);
  const proj = unwrap(project as Res<InstallProject>, 'Could not load this project.');
  if (!proj) return null;
  const billingRows = unwrap(billing as Res<ProjectBilling[]>, 'Could not load billing.') ?? [];
  const linkRows = unwrap(links as Res<JobLinkRow[]>, 'Could not load linked jobs.') ?? [];

  const jobIds = linkRows.map((l) => l.job_id);
  const [jobRows, invoices] = await Promise.all([
    jobIds.length
      ? (async () =>
          unwrap(
            (await supabase.from('jobs').select('id, customer_name, service_type, address, scheduled_datetime, job_status').eq('user_id', ownerId).in('id', jobIds)) as Res<JobRow[]>,
            'Could not load linked jobs.',
          ) ?? [])()
      : Promise.resolve([] as JobRow[]),
    fetchInvoicesById(ownerId, [...billingRows.map((b) => b.invoice_id ?? ''), proj.retainage_invoice_id ?? '']),
  ]);

  const jobMap = new Map(jobRows.map((j) => [j.id, j]));
  const jobs: LinkedJob[] = linkRows.flatMap((l) => {
    const j = jobMap.get(l.job_id);
    return j
      ? [{ link_id: l.id, job_id: l.job_id, phase_id: l.phase_id, customer_name: j.customer_name, service_type: j.service_type, address: j.address, scheduled_datetime: j.scheduled_datetime, job_status: j.job_status }]
      : [];
  });

  return {
    project: proj,
    phases: unwrap(phases as Res<ProjectPhase[]>, 'Could not load phases.') ?? [],
    milestones: unwrap(milestones as Res<ProjectMilestone[]>, 'Could not load milestones.') ?? [],
    billing: billingRows,
    materials: unwrap(materials as Res<ProjectMaterial[]>, 'Could not load materials.') ?? [],
    jobs,
    invoices,
  };
}

// ------------------------------------------------------------------
// Projects
// ------------------------------------------------------------------

export async function createProject(ownerId: string, v: ProjectFormValues): Promise<string> {
  const row = unwrap(
    (await supabase
      .from('install_projects')
      .insert({
        user_id: ownerId,
        name: v.name.trim(),
        customer_id: v.customerId || null,
        customer_name: v.customerName.trim(),
        site_address: v.siteAddress.trim() || null,
        project_type: v.projectType,
        contract_value_cents: dollarsToCents(v.contractValue) ?? 0,
        estimated_labor_cost_cents: dollarsToCents(v.laborEstimate) ?? 0,
        retainage_percent: Number(v.retainagePercent || 0),
        start_date: v.startDate || null,
        target_end_date: v.targetEndDate || null,
        notes: v.notes.trim() || null,
      })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not create the project.',
  );
  const id = row.id;
  if (!v.useTemplate) return id;

  try {
    const tpl = templateFor(v.projectType);
    const phases = unwrap(
      (await supabase
        .from('install_project_phases')
        .insert(tpl.phases.map((p, i) => ({ user_id: ownerId, project_id: id, name: p.name, weight: p.weight, sort_order: i })))
        .select('id, sort_order')) as Res<{ id: string; sort_order: number }[]>,
      'Could not create the phases.',
    );
    const phaseBySort = new Map(phases.map((p) => [p.sort_order, p.id]));
    const milestones = tpl.phases.flatMap((p, pi) =>
      p.milestones.map((m, mi) => ({ user_id: ownerId, project_id: id, phase_id: phaseBySort.get(pi), title: m.title, kind: m.kind, sort_order: mi })),
    );
    unwrap((await supabase.from('install_project_milestones').insert(milestones)) as Res<null>, 'Could not create the milestones.');
    unwrap(
      (await supabase.from('install_project_billing').insert(
        tpl.draws.map((d, i) => ({
          user_id: ownerId,
          project_id: id,
          phase_id: d.phaseIndex === null ? null : phaseBySort.get(d.phaseIndex) ?? null,
          label: d.label,
          percent_of_contract: d.percent,
          sort_order: i,
        })),
      )) as Res<null>,
      'Could not create the billing schedule.',
    );
  } catch (e) {
    // All-or-nothing: never leave a half-seeded project behind.
    await supabase.from('install_projects').delete().eq('id', id).eq('user_id', ownerId);
    throw e;
  }
  return id;
}

async function patch(table: string, ownerId: string, id: string, values: Record<string, unknown>, fallback: string): Promise<void> {
  unwrap((await supabase.from(table).update(values).eq('id', id).eq('user_id', ownerId)) as Res<null>, fallback);
}

async function remove(table: string, ownerId: string, id: string, fallback: string): Promise<void> {
  unwrap((await supabase.from(table).delete().eq('id', id).eq('user_id', ownerId)) as Res<null>, fallback);
}

export type ProjectPatch = Partial<
  Pick<InstallProject, 'name' | 'customer_name' | 'site_address' | 'contract_value_cents' | 'estimated_labor_cost_cents' | 'retainage_percent' | 'start_date' | 'target_end_date' | 'notes' | 'status'>
>;

export const updateProject = (ownerId: string, id: string, values: ProjectPatch) => patch('install_projects', ownerId, id, values, 'Could not update the project.');
export const setProjectStatus = (ownerId: string, id: string, status: ProjectStatus) => updateProject(ownerId, id, { status });
export const deleteProject = (ownerId: string, id: string) => remove('install_projects', ownerId, id, 'Could not delete the project.');

// ------------------------------------------------------------------
// Phases & milestones
// ------------------------------------------------------------------

export async function addPhase(ownerId: string, projectId: string, input: { name: string; weight: number; sortOrder: number }): Promise<void> {
  unwrap(
    (await supabase.from('install_project_phases').insert({ user_id: ownerId, project_id: projectId, name: input.name.trim(), weight: input.weight, sort_order: input.sortOrder })) as Res<null>,
    'Could not add the phase.',
  );
}

export const setPhaseStatus = (ownerId: string, id: string, status: PhaseStatus) => patch('install_project_phases', ownerId, id, { status }, 'Could not update the phase.');
export const deletePhase = (ownerId: string, id: string) => remove('install_project_phases', ownerId, id, 'Could not delete the phase.');

export async function addMilestone(
  ownerId: string,
  input: { projectId: string; phaseId: string; title: string; kind: MilestoneKind; dueDate: string; sortOrder: number },
): Promise<void> {
  unwrap(
    (await supabase.from('install_project_milestones').insert({
      user_id: ownerId,
      project_id: input.projectId,
      phase_id: input.phaseId,
      title: input.title.trim(),
      kind: input.kind,
      due_date: input.dueDate || null,
      sort_order: input.sortOrder,
    })) as Res<null>,
    'Could not add the milestone.',
  );
}

export const setMilestoneStatus = (ownerId: string, id: string, status: MilestoneStatus) =>
  patch('install_project_milestones', ownerId, id, { status }, 'Could not update the milestone.');
export const setMilestoneDueDate = (ownerId: string, id: string, dueDate: string) =>
  patch('install_project_milestones', ownerId, id, { due_date: dueDate || null }, 'Could not update the due date.');
export const deleteMilestone = (ownerId: string, id: string) => remove('install_project_milestones', ownerId, id, 'Could not delete the milestone.');

// ------------------------------------------------------------------
// Progress billing
// ------------------------------------------------------------------

export async function addBillingStep(
  ownerId: string,
  input: { projectId: string; label: string; percent: number; dueDate: string; phaseId: string; sortOrder: number },
): Promise<void> {
  unwrap(
    (await supabase.from('install_project_billing').insert({
      user_id: ownerId,
      project_id: input.projectId,
      label: input.label.trim(),
      percent_of_contract: input.percent,
      due_date: input.dueDate || null,
      phase_id: input.phaseId || null,
      sort_order: input.sortOrder,
    })) as Res<null>,
    'Could not add the billing step.',
  );
}

export const updateBillingStep = (ownerId: string, id: string, values: { label?: string; percent_of_contract?: number; due_date?: string | null }) =>
  patch('install_project_billing', ownerId, id, values, 'Could not update the billing step.');
export const deleteBillingStep = (ownerId: string, id: string) => remove('install_project_billing', ownerId, id, 'Could not delete the billing step.');

export async function createProgressInvoice(billingId: string, dueDate: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_project_invoice', { p_billing_id: billingId, p_due_date: dueDate || null });
  if (error) throw new Error(friendlyError(error, 'Could not create the invoice.'));
  return data as string;
}

export async function releaseRetainage(projectId: string, dueDate: string): Promise<string> {
  const { data, error } = await supabase.rpc('release_project_retainage', { p_project_id: projectId, p_due_date: dueDate || null });
  if (error) throw new Error(friendlyError(error, 'Could not release retainage.'));
  return data as string;
}

// ------------------------------------------------------------------
// Linked jobs
// ------------------------------------------------------------------

export async function fetchLinkableJobs(ownerId: string): Promise<JobRow[]> {
  const [jobs, links] = await Promise.all([
    supabase
      .from('jobs')
      .select('id, customer_name, service_type, address, scheduled_datetime, job_status')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(200),
    fetchAll<{ job_id: string }>(
      (a, b) => supabase.from('install_project_jobs').select('job_id').eq('user_id', ownerId).order('id').range(a, b) as unknown as PromiseLike<Res<{ job_id: string }[]>>,
      'Could not load linked jobs.',
    ),
  ]);
  const linked = new Set(links.map((l) => l.job_id));
  return (unwrap(jobs as Res<JobRow[]>, 'Could not load jobs.') ?? []).filter((j) => !linked.has(j.id));
}

export async function linkJob(ownerId: string, projectId: string, jobId: string, phaseId: string): Promise<void> {
  unwrap(
    (await supabase.from('install_project_jobs').insert({ user_id: ownerId, project_id: projectId, job_id: jobId, phase_id: phaseId || null })) as Res<null>,
    'Could not link the job.',
  );
}

export const unlinkJob = (ownerId: string, linkId: string) => remove('install_project_jobs', ownerId, linkId, 'Could not unlink the job.');

// ------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------

export interface MaterialInput {
  description: string;
  quantity: number;
  unit_label: string;
  unit_cost_cents: number;
  vendor: string;
  phase_id: string;
  part_id: string;
  expected_date: string;
}

export async function addMaterial(ownerId: string, projectId: string, m: MaterialInput): Promise<void> {
  unwrap(
    (await supabase.from('install_project_materials').insert({
      user_id: ownerId,
      project_id: projectId,
      description: m.description.trim(),
      quantity: m.quantity,
      unit_label: m.unit_label.trim() || null,
      unit_cost_cents: m.unit_cost_cents,
      vendor: m.vendor.trim() || null,
      phase_id: m.phase_id || null,
      part_id: m.part_id || null,
      expected_date: m.expected_date || null,
    })) as Res<null>,
    'Could not add the material.',
  );
}

export const setMaterialStatus = (ownerId: string, id: string, status: MaterialStatus) =>
  patch('install_project_materials', ownerId, id, { status }, 'Could not update the material.');
export const deleteMaterial = (ownerId: string, id: string) => remove('install_project_materials', ownerId, id, 'Could not delete the material.');

// ------------------------------------------------------------------
// Pickers
// ------------------------------------------------------------------

export interface CustomerOption {
  id: string;
  name: string;
  address: string | null;
}

export async function fetchCustomerOptions(ownerId: string): Promise<CustomerOption[]> {
  return (
    unwrap(
      (await supabase.from('customers').select('id, name, address').eq('user_id', ownerId).order('name').limit(1000)) as Res<CustomerOption[]>,
      'Could not load customers.',
    ) ?? []
  );
}

export interface InventoryPartOption {
  id: string;
  name: string;
  part_number: string | null;
  unit_label: string | null;
  unit_cost_cents: number;
}

export async function fetchInventoryPartOptions(ownerId: string): Promise<InventoryPartOption[]> {
  return (
    unwrap(
      (await supabase
        .from('inventory_parts')
        .select('id, name, part_number, unit_label, unit_cost_cents')
        .eq('user_id', ownerId)
        .eq('active', true)
        .order('name')
        .limit(500)) as Res<InventoryPartOption[]>,
      'Could not load inventory parts.',
    ) ?? []
  );
}
