// src/lib/winCardsApi.ts — typed wrappers for the win-cards (owner) and win-card-public (anonymous) edge functions.

import { supabase } from '@/lib/supabase';

export type TriggerType = 'after_hours_booking' | 'emergency_handled' | 'recovered_large_job' | 'milestone_calls' | 'speed_to_lead_record' | 'five_star_ai_job';
export type CardStatus = 'suggested' | 'approved' | 'revoked' | 'dismissed' | 'suspended';
export type Theme = 'light' | 'dark';

export interface PublicFields {
  v: 1; trigger: TriggerType; headline: string; detail: string | null; valueText: string | null; valueIsEstimate: boolean;
  timeBucketText: string | null; serviceText: string | null; monthText: string | null; businessName: string | null;
  showCta: boolean; disclaimer: string | null; caption: string | null;
}
export interface Selection {
  showValue: boolean; showTimeBucket: boolean; showMonth: boolean; showBusinessName: boolean; showCta: boolean;
  serviceLabel: string | null; caption: string | null;
}
export const DEFAULT_SELECTION: Selection = { showValue: false, showTimeBucket: false, showMonth: false, showBusinessName: false, showCta: true, serviceLabel: null, caption: null };

export interface WinCard {
  id: string; trigger_type: TriggerType; status: CardStatus;
  private_facts: { valueCents?: number; occurredAt: string; milestone?: number; responseMs?: number };
  public_fields: PublicFields | null; theme: Theme; token: string | null; attribution_ref: string | null;
  expires_at: string | null; approved_at: string | null; revoked_at: string | null; suspended_at: string | null;
  view_count: number; cta_count: number; share_count: number; report_count: number; created_at: string;
}
export interface WinCardSettings {
  enabled: boolean; staff_locked: boolean; default_expiry_days: number; theme: Theme; show_business_name: boolean;
  white_label: boolean; brand_name: string | null; accent_color: string | null; show_cta: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

async function call<T>(fn: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message; let code: string | undefined;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) { const b = await ctx.json(); message = b?.detail || b?.error || message; code = b?.error; }
    } catch { /* keep generic */ }
    return { ok: false, error: message, code };
  }
  if (data?.error) return { ok: false, error: data.detail || data.error, code: data.error };
  return { ok: true, data: data as T };
}

const owner = <T,>(body: Record<string, unknown>) => call<T>('win-cards', body);
export const listWinCards = () => owner<{ settings: WinCardSettings; cards: WinCard[]; siteUrl: string }>({ action: 'list' });
export const scanWinCards = () => owner<{ inserted: number; candidates: number }>({ action: 'scan' });
export const previewWinCard = (cardId: string, selection: Selection, theme: Theme) =>
  owner<{ public: PublicFields; captions: string[]; previews: { og: string; square: string; story: string } }>({ action: 'preview', cardId, selection, theme });
export const approveWinCard = (cardId: string, selection: Selection, theme: Theme, expiryDays?: number) =>
  owner<{ card: WinCard; url: string; alreadyApproved: boolean }>({ action: 'approve', cardId, selection, theme, expiryDays });
export const revokeWinCard = (cardId: string) => owner<{ ok: true }>({ action: 'revoke', cardId });
export const dismissWinCard = (cardId: string) => owner<{ ok: true }>({ action: 'dismiss', cardId });
export const extendWinCard = (cardId: string, days: number) => owner<{ ok: true; expiresAt: string }>({ action: 'extend', cardId, days });
export const recordWinCardShare = (cardId: string, channel: string) => owner<{ ok: true }>({ action: 'share', cardId, channel });
export const updateWinCardSettings = (settings: Partial<WinCardSettings>) => owner<{ settings: WinCardSettings }>({ action: 'update_settings', settings });

// ---- anonymous (public page)
export interface PublicCardPayload {
  card: { publicFields: PublicFields; theme: Theme; expiresAt: string };
  brand: { whiteLabel: boolean; brandName: string | null; accent: string | null };
  cta: boolean;
}
export async function fetchPublicWinCard(token: string): Promise<{ ok: true; data: PublicCardPayload } | { ok: false; reason: 'not_found' | 'error' }> {
  const { data, error } = await supabase.functions.invoke('win-card-public', { body: { token, action: 'get' } });
  if (error) return { ok: false, reason: (error as { context?: Response }).context?.status === 404 ? 'not_found' : 'error' };
  if (!data?.card) return { ok: false, reason: 'not_found' };
  return { ok: true, data: data as PublicCardPayload };
}
export const reportPublicWinCard = (token: string, reason: string, detail?: string) => call<{ ok: true }>('win-card-public', { token, action: 'report', reason, detail });
export const ctaPublicWinCard = (token: string) => call<{ url: string }>('win-card-public', { token, action: 'cta' });

export interface ChatTarget { connectionId: string; provider: string; workspace: string | null; channels: { id: string; name: string }[] }
export const winCardChatTargets = () => owner<{ targets: ChatTarget[] }>({ action: 'chat_targets' });
export const postWinCardToChat = (cardId: string, connectionId: string, channelId: string) => owner<{ ok: true }>({ action: 'post_chat', cardId, connectionId, channelId });
