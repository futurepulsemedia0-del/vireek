
export interface ExperimentRow { id: string; name: string; status: 'draft' | 'running' | 'stopped' | 'completed'; stop_reason: string | null; created_at: string }
export interface ExperimentReport {
  name: string; status: string; minPerArm: number;
  decision: { status: 'insufficient_data' | 'no_difference' | 'winner' | 'stop_guardrail'; arm?: string };
  arms: { key: string; voiceKey: string; calls: number; bookings: number; hangups: number; bookingRate: number; hangupRate: number }[];
}

export async function listExperiments(): Promise<ExperimentRow[]> {
  const { data, error } = await supabase.from('voice_experiments').select('id,name,status,stop_reason,created_at').order('created_at', { ascending: false }).limit(10);
  if (error) throw new Error('Could not load experiments.');
  return (data ?? []) as ExperimentRow[];
}
export const createExperiment = (name: string, voiceKeys: string[], minPerArm: number) =>
  call<{ id: string }>('voice-experiment', { action: 'create', name, minPerArm, arms: voiceKeys.map((voiceKey) => ({ voiceKey })) });
export const startExperiment = (id: string) => call<{ ok: true }>('voice-experiment', { action: 'start', id });
export const stopExperiment = (id: string) => call<{ ok: true }>('voice-experiment', { action: 'stop', id });
export const experimentReport = (id: string) => call<ExperimentReport>('voice-experiment', { action: 'report', id });
