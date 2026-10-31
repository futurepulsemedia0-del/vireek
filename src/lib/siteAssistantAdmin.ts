import { supabase } from '@/lib/supabase';

export interface AssistantGap {
  question: string;
  intent: string;
  occurrences: number;
  thumbs_down: number;
  ungrounded: number;
  avg_similarity: number | null;
  last_seen: string;
}

export interface AssistantStats {
  total: number;
  grounded_pct: number | null;
  thumbs_up: number;
  thumbs_down: number;
  cached_pct: number | null;
  handoffs: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p50_first_token_ms: number | null;
  p95_first_token_ms: number | null;
}

export async function fetchAssistantGaps(days = 30): Promise<AssistantGap[]> {
  const { data, error } = await supabase.rpc('get_site_assistant_gaps', { p_days: days });
  if (error) throw error;
  return (data ?? []) as AssistantGap[];
}

export async function fetchAssistantStats(days = 30): Promise<AssistantStats | null> {
  const { data, error } = await supabase.rpc('get_site_assistant_stats', { p_days: days });
  if (error) throw error;
  return ((data ?? [])[0] ?? null) as AssistantStats | null;
}
