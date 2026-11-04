import type { VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';

export interface VoiceDraft {
  id: string;
  status: 'ready' | 'approving' | 'approved' | 'discarded';
  extraction: VoiceExtraction;
  needs_review: boolean;
  transcript: string;
  created_at: string;
}
