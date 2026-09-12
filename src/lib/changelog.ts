/* ------------------------------------------------------------------ */
/*  changelog — single source of truth for release notes.              */
/*  Moved out of ChangelogPage.tsx so both the page AND the RSS-feed    */
/*  generator script (scripts/generate-rss.mjs) can import the same    */
/*  data without one dragging in the other's dependencies.             */
/*                                                                      */
/*  To ship a new release: add a new object to the TOP of              */
/*  CHANGELOG_RELEASES with today's date. Pick a `type` for each entry: */
/*  'new' | 'improved' | 'security' | 'fixed'. Keep descriptions        */
/*  specific and factual — what changed and why it matters to the      */
/*  person reading it, not marketing fluff.                            */
/* ------------------------------------------------------------------ */

export type EntryType = 'new' | 'improved' | 'security' | 'fixed';

export interface ChangelogEntry {
  type: EntryType;
  title: string;
  body: string;
}

export interface ChangelogRelease {
  date: string;
  entries: ChangelogEntry[];
}

export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    date: 'September 6, 2026',
    entries: [
      {
        type: 'improved',
        title: 'Team invite tracking',
        body: 'The Team page now shows when an invite was last sent, so you can tell at a glance whether it\u2019s time to resend one instead of guessing.',
      },
    ],
  },
  {
    date: 'September 5, 2026',
    entries: [
      {
        type: 'new',
        title: 'Dispatch Calendar',
        body: 'A new Calendar view in the dashboard lays out scheduled jobs with an estimated duration for each one, so you can see how a day or week is actually shaping up \u2014 not just a list of appointments.',
      },
      {
        type: 'new',
        title: 'Automated review requests',
        body: 'Jobs can now capture a customer\u2019s phone number, and your business profile can store a Google review link \u2014 the groundwork for sending a review request the moment a job is marked complete.',
      },
      {
        type: 'security',
        title: 'Trusted devices for login',
        body: 'Sign in from a device you\u2019ve already verified with a one-time code once, and that device can skip the OTP step next time. Unrecognized devices still require full verification. Device tokens live in an httpOnly cookie \u2014 only a hashed version is ever stored, and it\u2019s never reachable from client-side JavaScript.',
      },
    ],
  },
  {
    date: 'September 1, 2026',
    entries: [
      {
        type: 'new',
        title: 'Realtime dashboard updates',
        body: 'Overview, Call History, and the Jobs board now update the moment something happens \u2014 a new call, a new lead, a job status change from another session \u2014 with a subtle Live / Reconnecting indicator next to the page title so you always know whether you\u2019re looking at current data.',
      },
      {
        type: 'new',
        title: 'Command palette (\u2318K / Ctrl+K)',
        body: 'Jump straight to any dashboard page, or search your calls, leads, and jobs by name or phone number, from anywhere in the app.',
      },
      {
        type: 'improved',
        title: 'Faster Overview and Call History',
        body: 'Overview\u2019s stats queries are now bounded to a 120-day window instead of scanning your account\u2019s entire history every load, and Call History caps its fetch at the most recent 1,000 calls (clearly labeled) \u2014 so performance stays consistent as your account grows.',
      },
      {
        type: 'improved',
        title: 'Reorganized dashboard navigation',
        body: 'Business Profile, Team, Billing, Integrations, and Settings now live together under a collapsible \u201cAccount\u201d section in the sidebar, so the core workflow pages (Overview, Jobs, Calls, Leads, Analytics, Insights) get more room to breathe.',
      },
    ],
  },
  {
    date: 'August 31, 2026',
    entries: [
      {
        type: 'new',
        title: 'Notification Center',
        body: 'A bell icon in the header now surfaces emergency calls, new AI-generated insights, and job status changes as they happen, with mark-as-read and a full history at Dashboard \u2192 Notifications.',
      },
      {
        type: 'security',
        title: 'Two-factor authentication & audit log',
        body: 'Enable 2FA from Security Settings for an extra layer of protection on your account. Separately, sensitive changes \u2014 team permission edits, job deletions, billing plan changes, business profile edits, and integration connect/disconnect \u2014 are now written to an append-only audit log that only the account owner can read.',
      },
    ],
  },
  {
    date: 'August 30, 2026',
    entries: [
      {
        type: 'fixed',
        title: 'Rate limiting on the public demo chat',
        body: 'Added abuse protection to the live typed chat demo on the marketing site so it stays available and responsive for everyone trying it out.',
      },
    ],
  },
  {
    date: 'August 26, 2026',
    entries: [
      {
        type: 'new',
        title: 'Billing & subscription management',
        body: 'Manage your plan directly from the dashboard, backed by Stripe \u2014 no more emailing support to check what you\u2019re on.',
      },
    ],
  },
  {
    date: 'August 21, 2026',
    entries: [
      {
        type: 'new',
        title: 'Vireek launches',
        body: 'The first version of the platform: Sarah answering calls 24/7, a Leads and Jobs pipeline, team accounts with role-based access, and the core dashboard you see today.',
      },
    ],
  },
];
