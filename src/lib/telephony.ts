// Toll-free detection for US/Canada (NANP) numbers. Toll-free numbers
// use one of these seven prefixes right after the country code / area
// code position — see Twilio's own definition:
// https://www.twilio.com/docs/messaging/api/tollfree-verification-resource
const TOLL_FREE_PREFIXES = ['800', '833', '844', '855', '866', '877', '888'];

/** Strips everything but digits, then drops a leading "1" country code. */
export function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function isTollFreeNumber(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = normalizePhoneDigits(phone);
  if (digits.length !== 10) return false;
  return TOLL_FREE_PREFIXES.includes(digits.slice(0, 3));
}

export type TollFreeVerificationStatus = 'not_applicable' | 'not_started' | 'pending' | 'verified' | 'rejected';

export const TOLL_FREE_STATUS_LABELS: Record<TollFreeVerificationStatus, string> = {
  not_applicable: 'Not a toll-free number',
  not_started: 'Not started',
  pending: 'Pending carrier review',
  verified: 'Verified',
  rejected: 'Rejected — resubmission needed',
};

export const TOLL_FREE_STATUS_STYLES: Record<TollFreeVerificationStatus, string> = {
  not_applicable: 'bg-bg-tertiary text-text-secondary',
  not_started: 'bg-warning-500/15 text-warning-500',
  pending: 'bg-accent/10 text-accent',
  verified: 'bg-success-500/15 text-success-500',
  rejected: 'bg-danger/10 text-danger',
};
