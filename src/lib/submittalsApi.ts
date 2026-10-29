import { supabase } from '@/lib/supabase';
import { fetchAll, unwrap, type ItemEvent, type Res } from '@/lib/projectItemsCore';
import {
  normalizeSpecSection,
  type Submittal,
  type SubmittalAction,
  type SubmittalFormValues,
  type SubmittalRevision,
  type SubmittalStatus,
} from '@/lib/submittals';

// Submittals data layer. Status changes ONLY go through the
// install_submittal_transition RPC; plain updates cover descriptive fields.

export interface SubmittalRegister {
  submittals: Submittal[];
  revisions: SubmittalRevision[];
}

export async function fetchSubmittalRegister(ownerId: string, projectId: string): Promise<SubmittalRegister> {
  const [submittals, revisions] = await Promise.all([
    fetchAll<Submittal>(
      (a, b) => supabase.from('install_submittals').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('spec_section').order('seq').range(a, b) as unknown as PromiseLike<Res<Submittal[]>>,
      'Could not load submittals.',
    ),
    fetchAll<SubmittalRevision>(
      (a, b) =>
        supabase
          .from('install_submittal_revisions')
          .select('id, submittal_id, revision_number, submitted_at, decision, decided_at, decision_note')
          .eq('user_id', ownerId)
          .eq('project_id', projectId)
          .order('revision_number')
          .order('id')
          .range(a, b) as unknown as PromiseLike<Res<SubmittalRevision[]>>,
      'Could not load revisions.',
    ),
  ]);
  return { submittals, revisions };
}

export async function createSubmittal(ownerId: string, projectId: string, v: SubmittalFormValues): Promise<string> {
  const spec = normalizeSpecSection(v.specSection);
  if (!spec) throw new Error('Enter a valid spec section, e.g. 23 05 00.');
  const row = unwrap(
    (await supabase
      .from('install_submittals')
      .insert({
        user_id: ownerId,
        project_id: projectId,
        phase_id: v.phaseId || null,
        spec_section: spec,
        title: v.title.trim(),
        description: v.description.trim() || null,
        submittal_type: v.submittalType,
        reviewer_name: v.reviewerName.trim() || null,
        reviewer_email: v.reviewerEmail.trim() || null,
        due_date: v.dueDate || null,
      })
      .select('id')
      .single()) as Res<{ id: string }>,
    'Could not create the submittal.',
  );
  return row.id;
}

export type SubmittalPatch = Partial<Pick<Submittal, 'spec_section' | 'title' | 'description' | 'submittal_type' | 'reviewer_name' | 'reviewer_email' | 'due_date' | 'phase_id'>>;

export async function updateSubmittal(ownerId: string, id: string, values: SubmittalPatch): Promise<void> {
  unwrap((await supabase.from('install_submittals').update(values).eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not update the submittal.');
}

export async function transitionSubmittal(id: string, action: SubmittalAction, note?: string): Promise<SubmittalStatus> {
  const res = (await supabase.rpc('install_submittal_transition', { p_submittal_id: id, p_action: action, p_note: note?.trim() || null })) as Res<SubmittalStatus>;
  return unwrap(res, 'Could not update the submittal.');
}

export async function deleteDraftSubmittal(ownerId: string, id: string): Promise<void> {
  const res = (await supabase.from('install_submittals').delete().eq('id', id).eq('user_id', ownerId).select('id')) as Res<{ id: string }[]>;
  if ((unwrap(res, 'Could not delete the submittal.') ?? []).length === 0) throw new Error('Only a draft that was never submitted can be deleted. Void it instead.');
}

export async function fetchItemEvents(ownerId: string, itemType: 'submittal' | 'punch', itemId: string): Promise<ItemEvent[]> {
  const res = (await supabase
    .from('install_item_events')
    .select('id, item_type, item_id, action, from_status, to_status, revision_number, note, actor_name, created_at')
    .eq('user_id', ownerId)
    .eq('item_type', itemType)
    .eq('item_id', itemId)
    .order('created_at', { ascending: false })
    .limit(100)) as Res<ItemEvent[]>;
  return unwrap(res, 'Could not load the history.') ?? [];
}

/** True for owners, admins/managers and roles with manage-team or billing permission. */
export async function fetchCanReview(): Promise<boolean> {
  const res = (await supabase.rpc('can_review_install_items')) as Res<boolean>;
  return res.error ? false : res.data === true;
}
