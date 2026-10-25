/**
 * Wallet passes — pure helpers (types, labels, filtering, device detection). No I/O: unit-tested in walletPasses.test.ts.
 */

export type WalletKind = 'appointment' | 'membership' | 'protection' | 'gift_card' | 'tech_badge';

export const WALLET_KIND_ORDER: WalletKind[] = ['appointment', 'membership', 'protection', 'gift_card', 'tech_badge'];

export const WALLET_KIND_META: Record<WalletKind, { label: string; noun: string; description: string; searchHint: string; needsBilling: boolean }> = {
  appointment: { label: 'Appointments', noun: 'appointment pass', description: 'Live arrival time and technician — updates on the customer\'s phone as dispatch changes it.', searchHint: 'Search customer, service or address', needsBilling: false },
  membership: { label: 'Memberships', noun: 'membership card', description: 'Plan, status and benefits on a card the customer always has with them.', searchHint: 'Search member or plan', needsBilling: false },
  protection: { label: 'Protection & warranty', noun: 'service protection card', description: 'Equipment coverage and warranty end date, kept current automatically.', searchHint: 'Search customer or equipment', needsBilling: false },
  gift_card: { label: 'Gift cards', noun: 'gift card', description: 'Scannable balance that updates after every redemption.', searchHint: 'Search code or recipient', needsBilling: true },
  tech_badge: { label: 'Technician IDs', noun: 'technician ID', description: 'A verifiable badge customers can trust at the door.', searchHint: 'Search technician', needsBilling: false },
};

export interface WalletPassRow {
  id: string;
  kind: WalletKind;
  subject_id: string;
  label: string;
  status: 'active' | 'voided';
  version: number;
  share_token: string;
  apple_devices: number;
  google_synced: boolean;
  issued_via: 'dashboard' | 'portal' | 'sms' | 'api';
  pending_push: boolean;
  last_changed_at: string;
  last_pushed_at: string | null;
  created_at: string;
  voided_at: string | null;
}

export interface WalletCandidate {
  id: string;
  label: string;
  detail: string;
  phone: string | null;
  scheduled_at: string | null;
}

export interface IssueResult {
  id: string;
  share_token: string;
  url: string;
  sms?: { ok: boolean; message: string };
}

export interface WalletLanding {
  kind: WalletKind;
  status: 'active' | 'voided';
  org_name: string;
  color: string | null;
}

export type PassTone = 'success' | 'warning' | 'neutral' | 'danger';

export function passStatus(p: Pick<WalletPassRow, 'status' | 'apple_devices' | 'google_synced' | 'pending_push'>): { label: string; tone: PassTone } {
  if (p.status === 'voided') return { label: 'Voided', tone: 'danger' };
  if (p.pending_push) return { label: 'Updating…', tone: 'warning' };
  if (p.apple_devices > 0 || p.google_synced) return { label: 'In wallet', tone: 'success' };
  return { label: 'Not added yet', tone: 'neutral' };
}

export const TONE_CLASS: Record<PassTone, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning-500/30 bg-warning-500/10 text-warning-500',
  neutral: 'border-border bg-bg-tertiary text-text-secondary',
  danger: 'border-danger/30 bg-danger/10 text-danger',
};

export function filterPasses(rows: WalletPassRow[], kind: WalletKind, query: string): WalletPassRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => r.kind === kind && (!q || r.label.toLowerCase().includes(q)));
}

export function countByKind(rows: WalletPassRow[]): Record<WalletKind, number> {
  const out: Record<WalletKind, number> = { appointment: 0, membership: 0, protection: 0, gift_card: 0, tech_badge: 0 };
  for (const r of rows) if (r.status === 'active') out[r.kind] += 1;
  return out;
}

export const walletLandingUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/w/${token}`;

export type WalletDevice = 'ios' | 'android' | 'other';

export function detectDevice(ua: string, maxTouchPoints = 0): WalletDevice {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios'; // iPadOS desktop-class Safari
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Loose client-side check; the server normalizes and enforces E.164 + A2P/DNC gates. */
export function phoneLooksValid(v: string): boolean {
  const digits = v.replace(/\D/g, '');
  return digits.length === 10 || (digits.length >= 11 && digits.length <= 15);
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
