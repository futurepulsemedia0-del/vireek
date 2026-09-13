/* ------------------------------------------------------------------ */
/*  developerChangelog — single source of truth for API / webhook /    */
/*  SDK release notes. Deliberately separate from src/lib/changelog.ts */
/*  (that file is the PRODUCT changelog for dashboard users). This one */
/*  is for people integrating with Vireek programmatically — it should */
/*  only ever contain entries about the API, webhooks, SDKs, or the    */
/*  sandbox environment.                                               */
/*                                                                      */
/*  To ship a new entry: add a new object to the TOP of                */
/*  DEVELOPER_CHANGELOG_RELEASES with today's date. Pick a `type`:      */
/*  'api' | 'sdk' | 'webhook' | 'breaking'. Use 'breaking' only for     */
/*  changes that require integrators to update their code.             */
/* ------------------------------------------------------------------ */

export type DeveloperEntryType = 'api' | 'sdk' | 'webhook' | 'breaking';

export interface DeveloperChangelogEntry {
  type: DeveloperEntryType;
  title: string;
  body: string;
}

export interface DeveloperChangelogRelease {
  date: string;
  entries: DeveloperChangelogEntry[];
}

export const DEVELOPER_CHANGELOG_RELEASES: DeveloperChangelogRelease[] = [
  {
    date: 'September 13, 2026',
    entries: [
      {
        type: 'sdk',
        title: 'Developer Preview: Node.js and Python SDKs',
        body: 'Thin, typed client libraries for the Calls, Leads/Jobs, and Webhooks APIs are now available in preview for accounts with API access. See the SDKs page for install instructions.',
      },
      {
        type: 'api',
        title: 'Sandbox environment (request access)',
        body: 'A sandbox mode with synthetic calls and leads is now available on request, so integrations can be built and tested before they touch live customer data.',
      },
    ],
  },
];
