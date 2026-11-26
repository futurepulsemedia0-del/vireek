// Content and claims for the public /data-promise page.
// Every claim is derived from the real export lists (bundle.ts, coverage.ts) through portability.ts; a category is shown
// as available only if all its tables are exported AND the part that carries them is verified live (EXPORT_PARTS_LIVE).
import { TABLES } from '../../supabase/functions/_shared/tenant-export/bundle';
import { SUPPLEMENTARY_TABLES } from '../../supabase/functions/_shared/tenant-export/coverage';
import { EXPORT_PARTS_LIVE, PORTABILITY_CATEGORIES, PORTABILITY_EXEMPTIONS } from '../../supabase/functions/_shared/tenant-export/portability';

/** Delivery commitments. null = no commitment published. TODO(owner): set only what operations can really meet; TODO(counsel): wording. */
export const DATA_PROMISE_SLA: { assistedExportDays: number | null } = { assistedExportDays: null };

export const SCHEMA_URL = '/data-promise/export-schema.json';

export interface ClaimedCategory { id: string; label: string; description: string; available: boolean }

export function categoryClaims(): ClaimedCategory[] {
  const core = new Set<string>(TABLES);
  const supplement = new Set<string>(SUPPLEMENTARY_TABLES);
  return PORTABILITY_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    available: c.tables.every((t) => (core.has(t) && EXPORT_PARTS_LIVE.core) || (supplement.has(t) && EXPORT_PARTS_LIVE.supplement)),
  }));
}

export const NOT_INCLUDED: readonly string[] = [
  'Passwords, API keys and the connection settings for third-party services you linked.',
  'Live links that expire, such as video-room join links.',
  'The audio files of call recordings (the archive holds the link stored with each call).',
  'Records about other companies’ AI agents that called you have not been reviewed for export yet.',
];

export const exportedTableCount = (): number => (EXPORT_PARTS_LIVE.core ? TABLES.length : 0) + (EXPORT_PARTS_LIVE.supplement ? SUPPLEMENTARY_TABLES.length : 0);
export const exemptTableNames = (): string[] => PORTABILITY_EXEMPTIONS.map((e) => e.table);
