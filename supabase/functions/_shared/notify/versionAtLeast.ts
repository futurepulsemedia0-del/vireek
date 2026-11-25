// supabase/functions/_shared/notify/versionAtLeast.ts
// Kept in its own file so soundTiers.ts and mobilePayload.ts can both use it without a circular import.
// mobilePayload.ts re-exports it, so existing imports keep working.

/** "1.4.0" >= "1.3.2". False when either side is missing/malformed, so a feature gate fails closed. */
export function versionAtLeast(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  const a = version.split(".").map((x) => Number.parseInt(x, 10));
  const b = min.split(".").map((x) => Number.parseInt(x, 10));
  if ([...a, ...b].some((n) => Number.isNaN(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
