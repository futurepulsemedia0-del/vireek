/**
 * Wallet passes — API layer. All reads/writes go through SECURITY DEFINER RPCs or edge functions (the wallet tables
 * have no client access), so authorization lives server-side.
 */

import { supabase } from '@/lib/supabase';
import type { IssueResult, WalletCandidate, WalletKind, WalletLanding, WalletPassRow } from '@/lib/walletPasses';

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function fetchWalletPasses(): Promise<WalletPassRow[]> {
  const { data, error } = await supabase.rpc('wallet_list_passes', { p_kind: null, p_limit: 500 });
  if (error) throw error;
  return (data ?? []) as WalletPassRow[];
}

export async function fetchWalletCandidates(kind: WalletKind, search: string): Promise<WalletCandidate[]> {
  const { data, error } = await supabase.rpc('wallet_candidates', { p_kind: kind, p_search: search.trim() || null, p_limit: 25 });
  if (error) throw error;
  return (data ?? []) as WalletCandidate[];
}

export async function issueWalletPass(args: { kind: WalletKind; subjectId: string; timezone: string; sendSms?: boolean; phone?: string }): Promise<IssueResult> {
  const { data, error } = await supabase.functions.invoke('wallet-issue', {
    body: { action: 'issue', kind: args.kind, subject_id: args.subjectId, timezone: args.timezone, send_sms: !!args.sendSms, phone: args.phone },
  });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not create the pass.'));
  return data as IssueResult;
}

export async function voidWalletPass(passId: string): Promise<void> {
  const { error } = await supabase.rpc('wallet_void_pass', { p_pass_id: passId });
  if (error) throw error;
}

// ---- public (customer) ----

export async function fetchWalletLanding(token: string): Promise<WalletLanding | null> {
  const { data, error } = await supabase.rpc('get_wallet_landing', { p_token: token });
  if (error) throw error;
  return (data as WalletLanding | null) ?? null;
}

export interface PortalWalletOption { kind: WalletKind; subject_id: string; label: string }

export async function fetchPortalWalletOptions(portalToken: string): Promise<PortalWalletOption[]> {
  const { data, error } = await supabase.rpc('get_portal_wallet_options', { p_portal_token: portalToken });
  if (error) throw error;
  return (data ?? []) as PortalWalletOption[];
}

export async function issuePortalWalletPass(portalToken: string, opt: PortalWalletOption, timezone: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('wallet-issue', {
    body: { action: 'portal', portal_token: portalToken, kind: opt.kind, subject_id: opt.subject_id, timezone },
  });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not create your pass.'));
  return (data as { url: string }).url;
}

/** Direct download endpoints served by the wallet-pass edge function. */
export function walletFunctionBase(): string {
  return `${(import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, '') ?? ''}/functions/v1/wallet-pass`;
}
