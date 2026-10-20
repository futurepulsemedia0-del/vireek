import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { signPaths } from '@/lib/galleryApi';
import type { AnnotationPoint } from '@/lib/expertAssist';
import {
  potentialCents,
  type ApprovalResult,
  type FindingItemRow,
  type FindingItemView,
  type FindingsPackageRow,
  type PublicFindingsResult,
  type FindingSeverity,
} from '@/lib/findingsPackage';
import type { EstimateOption } from '@/lib/estimates';

export interface PackageListRow extends FindingsPackageRow {
  finding_count: number;
  potential_cents: number;
}

export interface PackageDetail {
  pkg: FindingsPackageRow;
  items: FindingItemView[];
}

export interface FindingsJobOption {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  created_at: string;
}

export interface FindingsPhoto {
  id: string;
  storage_path: string;
  caption: string | null;
  annotations: AnnotationPoint[];
  taken_at: string;
  url: string | null;
}

// ============================================================
// READS (always scoped to the ACCOUNT OWNER id; RLS enforces it too)
// ============================================================

export async function listPackages(ownerId: string): Promise<PackageListRow[]> {
  const { data, error } = await supabase
    .from('findings_packages')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const packages = (data as FindingsPackageRow[]) ?? [];
  if (packages.length === 0) return [];

  const { data: itemRows, error: itemError } = await supabase
    .from('findings_package_items')
    .select('package_id, severity, options, recommended_option_id')
    .in('package_id', packages.map((p) => p.id));
  if (itemError) throw itemError;

  const byPackage = new Map<string, Pick<FindingItemRow, 'severity' | 'options' | 'recommended_option_id'>[]>();
  for (const row of (itemRows ?? []) as (Pick<FindingItemRow, 'severity' | 'options' | 'recommended_option_id'> & { package_id: string })[]) {
    const list = byPackage.get(row.package_id) ?? [];
    list.push(row);
    byPackage.set(row.package_id, list);
  }
  return packages.map((p) => {
    const items = byPackage.get(p.id) ?? [];
    return { ...p, finding_count: items.length, potential_cents: potentialCents(items, p.tax_percent) };
  });
}

export async function fetchPackage(ownerId: string, id: string): Promise<PackageDetail | null> {
  const { data: pkg, error } = await supabase
    .from('findings_packages')
    .select('*')
    .eq('id', id)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!pkg) return null;

  const { data: rows, error: itemError } = await supabase
    .from('findings_package_items')
    .select('*')
    .eq('package_id', id)
    .order('sort_order', { ascending: true });
  if (itemError) throw itemError;

  const items = (rows as FindingItemRow[]) ?? [];
  const urls = await signPaths(items.map((i) => i.storage_path));
  return {
    pkg: pkg as FindingsPackageRow,
    items: items.map((i) => ({ ...i, photo_url: urls.get(i.storage_path) ?? null })),
  };
}

export async function fetchJobsForFindings(ownerId: string): Promise<FindingsJobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, address, created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as FindingsJobOption[]) ?? [];
}

export async function fetchJobPhotos(ownerId: string, jobId: string): Promise<FindingsPhoto[]> {
  const { data, error } = await supabase
    .from('job_photos')
    .select('id, storage_path, caption, annotations, taken_at')
    .eq('user_id', ownerId)
    .eq('job_id', jobId)
    .order('taken_at', { ascending: false })
    .limit(120);
  if (error) throw error;
  const rows = (data ?? []) as Omit<FindingsPhoto, 'url'>[];
  const urls = await signPaths(rows.map((r) => r.storage_path));
  return rows.map((r) => ({ ...r, url: urls.get(r.storage_path) ?? null }));
}

// ============================================================
// WRITES (draft only — the database enforces the lock)
// ============================================================

export async function createFromJob(jobId: string, photoIds: string[], title?: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_findings_package_from_job', {
    p_job_id: jobId,
    p_photo_ids: photoIds,
    p_title: title?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export type PackagePatch = Partial<
  Pick<FindingsPackageRow, 'title' | 'summary' | 'customer_email' | 'customer_phone' | 'address' | 'technician_name' | 'tax_percent' | 'share_enabled'>
>;

export async function updatePackage(id: string, patch: PackagePatch): Promise<void> {
  const { error } = await supabase.from('findings_packages').update(patch).eq('id', id);
  if (error) throw error;
}

export type ItemPatch = {
  title?: string;
  description?: string | null;
  severity?: FindingSeverity;
  annotations?: AnnotationPoint[];
  options?: EstimateOption[];
  recommended_option_id?: string | null;
  sort_order?: number;
};

export async function saveItem(id: string, patch: ItemPatch): Promise<void> {
  const { error } = await supabase.from('findings_package_items').update(patch).eq('id', id);
  if (error) throw error;
}

export async function addItemFromPhoto(
  ownerId: string,
  packageId: string,
  photo: FindingsPhoto,
  sortOrder: number,
): Promise<void> {
  const label = photo.annotations.find((a) => a.label)?.label;
  const { error } = await supabase.from('findings_package_items').insert({
    package_id: packageId,
    user_id: ownerId,
    sort_order: sortOrder,
    photo_id: photo.id,
    storage_path: photo.storage_path,
    title: (photo.caption?.trim() || label || `Finding ${sortOrder + 1}`).slice(0, 160),
    annotations: photo.annotations,
  });
  if (error) throw error;
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await supabase.from('findings_package_items').delete().eq('id', id);
  if (error) throw error;
}

export async function deletePackage(id: string): Promise<void> {
  const { error } = await supabase.from('findings_packages').delete().eq('id', id);
  if (error) throw error;
}

export async function sendPackage(id: string, expiresDays: number): Promise<string> {
  const { data, error } = await supabase.rpc('send_findings_package', { p_id: id, p_expires_days: expiresDays });
  if (error) throw error;
  return data as string;
}

export async function reopenPackage(id: string): Promise<void> {
  const { error } = await supabase.rpc('reopen_findings_package', { p_id: id });
  if (error) throw error;
}

// ============================================================
// PUBLIC (customer) — edge function only
// ============================================================

export async function fetchPublicFindings(token: string): Promise<PublicFindingsResult> {
  const { data, error } = await supabase.functions.invoke('findings-package-public', { body: { action: 'get', token } });
  if (error) {
    const status = error instanceof FunctionsHttpError ? error.context.status : 0;
    if (status === 404) return { ok: false, reason: 'not_found' };
    if (status === 410) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'error' };
  }
  if (!data?.package) return { ok: false, reason: 'not_found' };
  return { ok: true, data: data };
}

export class RespondError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const RESPOND_MESSAGES: Record<string, string> = {
  ALREADY_RESPONDED: 'This report was already answered. Thank you!',
  EXPIRED: 'This link has expired. Please ask us for a fresh one.',
  NOT_FOUND: 'This link is no longer active.',
  INCOMPLETE_DECISIONS: 'Please review every recommended repair before confirming.',
  INVALID_OPTION: 'One of the options changed. Reload the page and try again.',
};

export async function respondToFindings(
  token: string,
  decisions: { item_id: string; option_id: string | null }[],
  approverName: string,
): Promise<ApprovalResult> {
  const { data, error } = await supabase.functions.invoke('findings-package-public', {
    body: { action: 'respond', token, decisions, approver_name: approverName },
  });
  if (error) {
    const body = error instanceof FunctionsHttpError ? ((await error.context.json().catch(() => null)) as { error?: string } | null) : null;
    const code = body?.error ?? 'INTERNAL';
    throw new RespondError(code, RESPOND_MESSAGES[code] ?? 'Something went wrong. Please try again.');
  }
  return data.result as ApprovalResult;
}
