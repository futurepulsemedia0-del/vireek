import type { OutboundCampaignType } from '@/lib/outboundCampaigns';

// ============================================================
// Types
// ============================================================

export type DropCampaignType = OutboundCampaignType;
export type VoicemailDropStatus = 'active' | 'archived';
export type DropStatusFilter = 'active' | 'archived' | 'all';

export interface ComplianceFlags {
  discloses_business_name: boolean;
  includes_callback_number: boolean;
  includes_opt_out: boolean;
  consent_confirmed: boolean;
}

export interface VoicemailDrop extends ComplianceFlags {
  id: string;
  account_owner_id: string;
  name: string;
  description: string | null;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  transcript: string | null;
  campaign_types: DropCampaignType[];
  uses_ai_voice: boolean;
  compliance_ready: boolean;
  status: VoicemailDropStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VoicemailDropStats {
  drop_id: string;
  total_uses: number;
  uses_30d: number;
  delivered: number;
  failed: number;
  last_used_at: string | null;
}

// ============================================================
// Constants
// ============================================================

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 120;
export const MAX_NAME_LENGTH = 120;
export const ALLOWED_EXTENSIONS = ['mp3', 'wav'];
export const ALLOWED_MIME_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'];

export const DROP_CAMPAIGN_OPTIONS: { type: DropCampaignType; label: string }[] = [
  { type: 'quote_followup', label: 'Quote follow-up' },
  { type: 'appointment_reminder', label: 'Appointment reminder' },
  { type: 'review_request_call', label: 'Review request' },
];

export const DROP_CAMPAIGN_LABELS: Record<DropCampaignType, string> = {
  quote_followup: 'Quote follow-up',
  appointment_reminder: 'Appointment reminder',
  review_request_call: 'Review request',
};

export const COMPLIANCE_CHECKS: { key: keyof ComplianceFlags; label: string; hint: string }[] = [
  {
    key: 'discloses_business_name',
    label: 'Names your business at the start',
    hint: 'The recording says who is calling within the first few seconds.',
  },
  {
    key: 'includes_callback_number',
    label: 'Gives a callback number',
    hint: 'Listeners can reach a real person at the number you state.',
  },
  {
    key: 'includes_opt_out',
    label: 'Explains how to opt out',
    hint: 'For example "reply STOP" or "call us to be removed".',
  },
  {
    key: 'consent_confirmed',
    label: 'Recipients have given consent',
    hint: 'You have prior express consent to send prerecorded or AI-voice messages to the people you will use this with.',
  },
];

// ============================================================
// Compliance
// ============================================================

export function isComplianceReady(flags: ComplianceFlags): boolean {
  return COMPLIANCE_CHECKS.every((c) => flags[c.key]);
}

/** Labels of the checklist items that are still unchecked. */
export function getComplianceGaps(flags: ComplianceFlags): string[] {
  return COMPLIANCE_CHECKS.filter((c) => !flags[c.key]).map((c) => c.label);
}

// ============================================================
// Validation
// ============================================================

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > -1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function validateAudioFile(file: { name: string; type: string; size: number }): string | null {
  if (!file.size) return 'This file is empty.';
  if (!ALLOWED_EXTENSIONS.includes(fileExtension(file.name))) {
    return 'Use an MP3 or WAV file. Other formats do not play reliably on voicemail systems.';
  }
  if (file.type && !ALLOWED_MIME_TYPES.includes(file.type)) {
    return 'That file does not look like an MP3 or WAV recording.';
  }
  if (file.size > MAX_FILE_BYTES) {
    return `File is too large (max ${formatBytes(MAX_FILE_BYTES)}).`;
  }
  return null;
}

export function validateDropName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give this drop a name.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  return null;
}

/** Content type we store and send to Storage (the bucket only allows these two). */
export function audioContentType(fileName: string): 'audio/mpeg' | 'audio/wav' {
  return fileExtension(fileName) === 'wav' ? 'audio/wav' : 'audio/mpeg';
}

// ============================================================
// Storage paths
// ============================================================

export function sanitizeFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const safeBase =
    base
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'voicemail';
  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 5);
  return safeExt ? `${safeBase}.${safeExt}` : safeBase;
}

/** `<ownerId>/<uid>-<safe-name>` : the first folder is what the storage policy checks. */
export function buildStoragePath(accountOwnerId: string, fileName: string, uid: string): string {
  return `${accountOwnerId}/${uid}-${sanitizeFileName(fileName)}`;
}

// ============================================================
// Formatting
// ============================================================

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ============================================================
// Stats + filtering
// ============================================================

export function deliveryRate(stats: Pick<VoicemailDropStats, 'delivered' | 'failed'> | undefined): number | null {
  if (!stats) return null;
  const total = stats.delivered + stats.failed;
  return total === 0 ? null : Math.round((stats.delivered / total) * 100);
}

export interface LibrarySummary {
  total: number;
  active: number;
  archived: number;
  complianceReady: number;
  needsReview: number;
  uses30d: number;
  deliveryRate: number | null;
}

export function summarizeLibrary(
  drops: VoicemailDrop[],
  stats: Record<string, VoicemailDropStats>,
): LibrarySummary {
  const active = drops.filter((d) => d.status === 'active');
  let uses30d = 0;
  let delivered = 0;
  let failed = 0;
  for (const d of drops) {
    const s = stats[d.id];
    if (!s) continue;
    uses30d += s.uses_30d;
    delivered += s.delivered;
    failed += s.failed;
  }
  return {
    total: drops.length,
    active: active.length,
    archived: drops.length - active.length,
    complianceReady: active.filter((d) => d.compliance_ready).length,
    needsReview: active.filter((d) => !d.compliance_ready).length,
    uses30d,
    deliveryRate: deliveryRate({ delivered, failed }),
  };
}

export function filterDrops(
  drops: VoicemailDrop[],
  { status, query }: { status: DropStatusFilter; query: string },
): VoicemailDrop[] {
  const q = query.trim().toLowerCase();
  return drops.filter((d) => {
    if (status !== 'all' && d.status !== status) return false;
    if (!q) return true;
    return [d.name, d.description, d.file_name, d.transcript].some((v) => v?.toLowerCase().includes(q));
  });
}
