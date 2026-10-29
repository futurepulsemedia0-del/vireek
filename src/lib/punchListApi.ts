import { supabase } from '@/lib/supabase';
import { fetchAll, unwrap, type Res } from '@/lib/projectItemsCore';
import type { PunchAction, PunchFormValues, PunchItem, PunchPriority, PunchStatus } from '@/lib/punchList';

// Punch list data layer. Status changes ONLY go through the
// install_punch_transition RPC; plain updates cover descriptive fields.

export interface AssigneeOption {
  id: string;
  name: string;
  role: string | null;
}

export interface PunchData {
  items: PunchItem[];
  assignees: AssigneeOption[];
  /** The signed-in user's own team_members.id (null for the owner). */
  myMemberId: string | null;
}

export async function fetchPunchData(ownerId: string, projectId: string, userId: string | null): Promise<PunchData> {
  const [items, members] = await Promise.all([
    fetchAll<PunchItem>(
      (a, b) => supabase.from('install_punch_items').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('seq').range(a, b) as unknown as PromiseLike<Res<PunchItem[]>>,
      'Could not load the punch list.',
    ),
    supabase.from('team_members').select('id, member_name, member_email, role, user_id').eq('account_owner_id', ownerId).order('member_name').limit(500),
  ]);
  const rows = unwrap(members as Res<{ id: string; member_name: string | null; member_email: string; role: string | null; user_id: string | null }[]>, 'Could not load your team.') ?? [];
  return {
    items,
    assignees: rows.map((m): AssigneeOption => ({ id: m.id, name: m.member_name?.trim() || m.member_email, role: m.role })),
    myMemberId: userId ? rows.find((m) => m.user_id === userId)?.id ?? null : null,
  };
}

export async function createPunchItem(ownerId: string, projectId: string, v: PunchFormValues): Promise<string> {
  const row = unwrap(
    (await supabase
      .from('install_punch_items')
      .insert({
        user_id: ownerId,
        project_id: projectId,
        phase_id: v.phaseId || null,
        title: v.title.trim(),
        location: v.location.trim(),
        description: v.description.trim() || null,
        priority: v.priority,
        assignee_id: v.assigneeId || null,
        due_date: v.dueDate || null,
      })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not add the punch item.',
  );
  return row.id;
}

export type PunchPatch = Partial<{ title: string; location: string; description: string | null; priority: PunchPriority; assignee_id: string | null; due_date: string | null; phase_id: string | null }>;

export async function updatePunchItem(ownerId: string, id: string, values: PunchPatch): Promise<void> {
  unwrap((await supabase.from('install_punch_items').update(values).eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not update the punch item.');
}

export async function transitionPunchItem(id: string, action: PunchAction, note?: string): Promise<PunchStatus> {
  const res = (await supabase.rpc('install_punch_transition', { p_item_id: id, p_action: action, p_note: note?.trim() || null })) as Res<PunchStatus>;
  return unwrap(res, 'Could not update the punch item.');
}

export async function deletePunchItem(ownerId: string, id: string): Promise<void> {
  const res = (await supabase.from('install_punch_items').delete().eq('id', id).eq('user_id', ownerId).select('id')) as Res<{ id: string }[]>;
  if ((unwrap(res, 'Could not delete the punch item.') ?? []).length === 0) throw new Error('Closed items cannot be deleted. Reopen the item first.');
}

/** Items that are not closed yet — used to warn before completing a project. */
export async function countOpenPunchItems(ownerId: string, projectId: string): Promise<number> {
  const res = (await supabase
    .from('install_punch_items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', ownerId)
    .eq('project_id', projectId)
    .neq('status', 'closed')) as unknown as { count: number | null; error: { message: string } | null };
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}
