// supabase/functions/_shared/number-reputation/attempts.ts
//
// MINIMAL REPAIR (not a feature): vapi-webhook imports { recordAttemptOutcome } from this path, but the module is
// missing from the repository snapshot. This no-op restores the import so the webhook can load. It records nothing.
// Replace it with the real implementation when the Number Reputation feature is added to the repo.

export async function recordAttemptOutcome(_admin: unknown, _message: unknown): Promise<void> {
  return;
}
