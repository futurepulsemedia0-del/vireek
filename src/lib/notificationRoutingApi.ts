import { supabase } from '@/lib/supabase';
import type { DeliveryRow, PreviewResult, RoutingRule, RoutingSettings, RuleRow, Severity } from '@/lib/notificationRouting';

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function listRules(): Promise<RoutingRule[]> {
  const { data, error } = await supabase
    .from('notification_routing_rules')
    .select('*')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load rules.');
  return (data ?? []) as RoutingRule[];
}

export async function createRule(row: RuleRow): Promise<void> {
  const { error } = await supabase.from('notification_routing_rules').insert(row);
  if (error) fail(error, 'Could not create the rule.');
}

export async function updateRule(id: string, row: Partial<RuleRow>): Promise<void> {
  const { error } = await supabase.from('notification_routing_rules').update(row).eq('id', id);
  if (error) fail(error, 'Could not save the rule.');
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('notification_routing_rules').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the rule.');
}

export async function listDeliveries(limit = 40): Promise<DeliveryRow[]> {
  const { data, error } = await supabase
    .from('notification_deliveries')
    .select('id, notification_id, rule_id, notification_type, severity, channel, recipient_label, status, error, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load the delivery log.');
  return (data ?? []) as DeliveryRow[];
}

export async function getSettings(): Promise<RoutingSettings> {
  const { data, error } = await supabase.rpc('get_notification_routing_settings');
  if (error) fail(error, 'Could not load settings.');
  const row = Array.isArray(data) ? data[0] : data;
  return {
    slack_configured: Boolean(row?.slack_configured),
    slack_hint: row?.slack_hint ?? null,
    fallback_to_push: row?.fallback_to_push ?? true,
  };
}

export async function saveSettings(patch: { slackWebhookUrl?: string; clearSlack?: boolean; fallbackToPush?: boolean }): Promise<void> {
  const { error } = await supabase.rpc('set_notification_routing_settings', {
    p_slack_webhook_url: patch.slackWebhookUrl ?? null,
    p_clear_slack: patch.clearSlack ?? false,
    p_fallback_to_push: patch.fallbackToPush ?? null,
  });
  if (error) fail(error, 'Could not save settings.');
}

/** "Who would be notified?" — nothing is sent. `at` lets the owner test a different day/time. */
export async function previewRouting(input: { type: string; severity: Severity; at?: string }): Promise<PreviewResult> {
  const { data, error } = await supabase.functions.invoke('notification-router', { body: { dry_run: true, ...input } });
  if (error) fail(error, 'Preview failed.');
  return data as PreviewResult;
}

/** Real end-to-end test: inserts a critical notification, which the database trigger routes. */
export async function sendTestAlert(): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    type: 'system',
    title: 'Test alert from notification routing',
    message: 'If you can read this, your routing rules reached you.',
    severity: 'critical',
    action_url: '/dashboard/notification-routing',
  });
  if (error) fail(error, 'Could not send the test alert.');
}

export interface ScheduleOption {
  id: string;
  name: string;
  tierCount: number;
}

export async function listSchedules(): Promise<ScheduleOption[]> {
  const [{ data: schedules, error }, { data: tiers }] = await Promise.all([
    supabase.from('on_call_schedules').select('id, name').order('created_at', { ascending: true }),
    supabase.from('escalation_tiers').select('schedule_id'),
  ]);
  if (error) fail(error, 'Could not load on-call schedules.');
  const counts = new Map<string, number>();
  for (const t of tiers ?? []) counts.set(t.schedule_id, (counts.get(t.schedule_id) ?? 0) + 1);
  return (schedules ?? []).map((s) => ({ id: s.id, name: s.name, tierCount: counts.get(s.id) ?? 0 }));
}
