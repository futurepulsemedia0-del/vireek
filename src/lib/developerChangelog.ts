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
    date: 'November 1, 2026',
    entries: [
      {
        type: 'api',
        title: 'Test and live API keys, IP allowlist, and fixed “last used”',
        body: 'Keys can now be created in Test mode (vrk_test_…): they return deterministic synthetic data with livemode: false and never touch your account. Keys can be restricted to an IP allowlist (Beta; blocked requests get 403 ip_not_allowed). Responses include X-Vireek-Mode and X-Vireek-Api-Version, and the API reserves Deprecation and Sunset headers for future deprecations. We also fixed a bug that stopped “Last used” from ever updating, and API keys can now be created with every scope the dashboard offers.',
      },
      {
        type: 'sdk',
        title: 'TypeScript SDK (Beta), Insomnia collection, quickstarts and docs search',
        body: 'A generated, typed TypeScript client (packages/sdk) with retries and pagination helpers, an Insomnia collection next to the Postman one, three quickstarts whose code is executed in CI, and Cmd+K search across the docs.',
      },
      {
        type: 'api',
        title: 'Error codes, request ids and code samples',
        body: 'Every api-v1 error now also carries code, doc_url and request_id (the existing error string is unchanged), every response has an X-Request-Id header, 405 responses include Allow, and authenticated responses include X-RateLimit-Limit. The API Reference has a full error catalog and cURL, JavaScript, Python and Go samples for every endpoint.',
      },
      {
        type: 'webhook',
        title: 'Webhook event catalog, signature verification guide and Beta labels',
        body: 'The webhook docs now list all nine Event Bus events with sample payloads, a signature verification guide (JavaScript, Python, Go), and the delivery and retry policy. Events other than call.created, lead.created and job.created are labeled Beta. The OpenAPI spec now includes a webhooks section.',
      },
    ],
  },
  {
    date: 'October 28, 2026',
    entries: [
      {
        type: 'api',
        title: 'OpenAPI 3.1 spec published at /openapi.json',
        body: 'The API Reference now renders from the same contract the API runs on. api-v1 returns 400 for a malformed id or before value (previously 500), paths with extra segments such as /calls/<id>/x now return 404, and 429 responses are documented with Retry-After.',
      },
    ],
  },
  {
    date: 'October 9, 2026',
    entries: [
      {
        type: 'api',
        title: 'API Reference, OpenAPI spec, Postman collection and per-key request logs',
        body: 'A new API Reference page ships an OpenAPI 3 spec and a Postman collection for api-v1, and every authenticated request is now logged per API key (30-day retention) and viewable by the account owner.',
      },
    ],
  },
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
