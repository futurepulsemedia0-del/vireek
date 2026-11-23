// supabase/functions/_shared/lifecycle/registry.ts
//
// THE registry of deprecated and sunset features (policy: docs/product/lifecycle-policy.md). One entry per thing being
// removed. Adding an entry is the announcement: in the same change the developer changelog / product changelog entry
// goes out (policy step "Announce"), because from this commit
//   * api-v1 sends Deprecation + Sunset + Link headers for entries that carry `api`,
//   * the dashboard shows the banner for entries with `banner.enabled`.
// `deprecations.test.ts` validates every entry (real dates, notice period for its class, https links, export plan)
// and fails the build on a mistake. Entries are never deleted: when removal ships, set `removedAt` (history stays).
//
// Nothing is deprecated today, so the list is empty. Example (do not copy the dates):
//
//   {
//     id: 'api-jobs-v1-notes-field',
//     kind: 'api_resource',
//     noticeClass: 'stable',
//     title: 'Jobs API',
//     summary: 'Move to the replacement endpoint before the sunset date to keep your integration working.',
//     owner: 'integrations',
//     announcedAt: '2027-01-15',
//     sunsetAt: '2027-04-15',            // >= 90 days after announcedAt for a stable surface
//     migrationUrl: 'https://vireek.com/docs/migrate/jobs',
//     api: { resource: 'jobs' },
//     dataExport: { holdsCustomerData: false },
//     banner: { enabled: false },        // API-only changes need no dashboard banner
//   },

import type { DeprecationEntry } from './deprecations.ts';

export const DEPRECATION_REGISTRY: readonly DeprecationEntry[] = [];
