export type CredentialStatus = 'valid' | 'expiring_soon' | 'expired' | 'revoked' | 'pending_renewal';

export const CREDENTIAL_STATUS_LABELS: Record<CredentialStatus, string> = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  revoked: 'Revoked',
  pending_renewal: 'Pending renewal',
};

export const CREDENTIAL_STATUS_COLORS: Record<CredentialStatus, string> = {
  valid: 'bg-success-500/10 text-success-500',
  expiring_soon: 'bg-warning-500/10 text-warning-500',
  expired: 'bg-danger/10 text-danger',
  revoked: 'bg-danger/10 text-danger',
  pending_renewal: 'bg-bg-tertiary text-text-secondary',
};

const EXPIRY_WARNING_DAYS = 30;

// Mirrors the server-side rule in technician_compliance_gaps(): a
// credential counts as currently valid only if status='active' AND
// (no expiry, or expiry hasn't passed yet).
export function computeCredentialStatus(
  status: 'active' | 'revoked' | 'pending_renewal',
  expiresAt: string | null
): CredentialStatus {
  if (status === 'revoked') return 'revoked';
  if (status === 'pending_renewal') return 'pending_renewal';
  if (!expiresAt) return 'valid';
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
  if (days < 0) return 'expired';
  if (days <= EXPIRY_WARNING_DAYS) return 'expiring_soon';
  return 'valid';
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}
