import { supabase } from '@/lib/supabase';
import type { QuoteLineItem } from '@/lib/quotes';

export interface VisualEstimateResult {
  detected_issue: string;
  service_type: string;
  severity: 'low' | 'medium' | 'high' | 'emergency' | string;
  confidence: number;
  line_items: QuoteLineItem[];
}

export const MAX_ESTIMATE_PHOTOS = 3;

const SEVERITY_LABELS: Record<string, string> = {
  low: 'Low priority', medium: 'Medium priority', high: 'High priority', emergency: 'Emergency',
};
export function severityLabel(s: string): string {
  return SEVERITY_LABELS[s] ?? s;
}

/** Uploads one photo to the caller's own folder in the private estimate-photos bucket. */
export async function uploadEstimatePhoto(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('estimate-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Sends already-uploaded photo paths to the AI estimator and returns a draft the caller must review. */
export async function getVisualEstimate(storagePaths: string[]): Promise<VisualEstimateResult> {
  const { data, error } = await supabase.functions.invoke('visual-estimate', { body: { storagePaths } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as VisualEstimateResult;
}
