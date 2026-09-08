# Implementation notes — realtime, AI assistant, notifications, security, performance, nav

This documents everything added on top of the original `vireek-main` codebase, why it's
built the way it is, and what you need to do before/after merging.

**I could not run `npm install`, `npm run typecheck`, or `npm run build` in the environment
this was built in (no network access) — the checklist below tells you what to run once you
pull this in.** I did do a manual isolated syntax/type pass with `tsc` on every changed file
and found no new errors beyond a few pre-existing false positives (present in your original
`JobsPage.tsx` too) caused by not having `node_modules` available — but that is not a
substitute for actually building it.

## 0. Two things your prompts assumed that didn't exist yet

- There was no `/dashboard/settings` page and no `notify_email_emergency` /
  `notify_sms_booking` toggles anywhere in the repo. I built `SettingsPage.tsx` fresh with a
  `notification_preferences` jsonb column instead of extending toggles that weren't there.
- There was no `/dashboard/settings/security` page. `SecurityPage.tsx` in your repo is the
  public marketing page at `/security`, unrelated. I built a new, separate
  `SecuritySettingsPage.tsx`.

## 1. Setup checklist (do these in order)

1. `npm install` — no new npm dependencies were added, this just gets you back to a clean
   `node_modules`.
2. `npm run typecheck` and `npm run build` — confirm everything compiles in your real
   environment before deploying.
3. Run the two new migrations against your Supabase project:
   - `supabase/migrations/20260901090000_create_notifications.sql`
   - `supabase/migrations/20260901090100_create_audit_log.sql`
   (`supabase db push` or however you normally apply migrations — they're additive, no
   existing table's columns or policies are touched except one new column on `profiles`.)
4. Deploy the new edge function: `supabase functions deploy ai-assistant-query`
5. Set the Anthropic secret if it isn't already set from `demo-chat`:
   `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
   (Optional: `ANTHROPIC_MODEL` to override the default `claude-haiku-4-5-20251001`.)
6. Redeploy `check-usage-alert` — it was updated to also write into `notifications`.
7. Nothing needs to change in `.env` / `.env.example` — no new `VITE_*` variables were
   introduced.

## 2. What was actually built (all real, not stubbed)

### Realtime (prompt 11)
- `src/lib/realtime.ts` — `useRealtimeInsert`, `useRealtimeUpdate`, `useRealtimeStatus`.
- Overview: live call/job inserts update stat cards and the Recent Activity feed with a
  brief highlight flash on the newest item.
- Call History: new calls appear at the top instantly.
- Jobs board: INSERT + UPDATE both wired, so a status change from another session (or an
  automated process) reflects live for anyone else viewing the board — filtered so a
  technician without `can_view_all_jobs` never receives a row they shouldn't see.
- A `Live` / `Reconnecting…` indicator sits next to the page title on all three pages,
  driven by the channel's actual `SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` status — not a
  fake always-on badge.
- **Important correctness fix**: every one of the above filters realtime rows by
  `user_id = eq.<account owner id>`, not the logged-in user's own id. For a team member
  those are different values (`calls`/`jobs`/`notifications` are always keyed by the
  *owner's* id). I added `accountOwnerId` to `AuthContext` specifically for this — using
  `user.id` here would have silently broken realtime for every team-member account while
  working fine for owners in testing. Worth knowing about since it's an easy mistake to
  reintroduce later.

### AI Assistant (prompt 12)
- `src/components/AiAssistantPanel.tsx` — floating button, slide-in chat, starter prompts,
  typing indicator, inline table rendering for numeric answers.
- `supabase/functions/ai-assistant-query/index.ts` — **deliberately not text-to-SQL.** An
  LLM that writes its own queries is one prompt-injection away from a query you didn't
  intend, and validating arbitrary generated SQL is its own hard problem. Instead the
  function authenticates the caller from their session JWT, fetches a fixed, pre-aggregated
  snapshot (counts, rates, and a capped slice of recent rows) through a Supabase client
  scoped to that JWT — so Postgres RLS enforces the account boundary independent of
  anything the model decides — and only then hands Claude the already-scoped snapshot plus
  the question. The model never sees a connection string, never runs a query, and can't
  answer about data it wasn't handed. Counts/percentages are computed in the edge function,
  not left for the LLM to tally, since LLMs are unreliable at counting rows.
- No per-user rate limiting was added (unlike `demo-chat`, which needs it because it's
  public/unauthenticated). If usage costs become a concern, copy the `demo_chat_rate_limit`
  pattern keyed by `user_id` instead of an IP hash.

### Notification center (prompt 13)
- `notifications` table + `notification_preferences` jsonb column on `profiles`.
- Creation happens via **database triggers**, not application code — emergency calls,
  new AI insights, and jobs that land back in `scheduled` after their time has passed (or
  get cancelled mid-progress) all insert automatically, regardless of which client or
  integration caused the underlying change. `check-usage-alert` also inserts directly since
  it already runs as a scheduled function.
- One real gap, called out in the migration itself: a job created as `scheduled` and never
  touched again won't get flagged the moment its time passes, because there's no row
  event to hang a trigger on. The migration includes the exact `pg_cron` snippet to fix
  this if/when you enable pg_cron on the project — I didn't enable it myself since that's a
  project-level decision, not something a migration should silently turn on.
- `NotificationBell.tsx` (header dropdown, live-updating, mark-as-read), full history at
  `/dashboard/notifications`, and preference toggles in `/dashboard/settings`.

### Security (prompt 15)
- `audit_log` table, RLS restricted to `user_id = auth.uid()` (the actual owner, stricter
  than the account-wide `get_account_owner_id()` used elsewhere) — a team member triggers
  the logged actions but can never read the log. Append-only: no UPDATE/DELETE policy at
  all, even for the owner, through the API.
- Triggers cover: team permission changes, job deletions, billing plan changes, business
  profile edits, integration connect/disconnect.
- Two-factor authentication is **real**, using `supabase.auth.mfa` (`enroll` →
  `challengeAndVerify` → `listFactors`/`unenroll`) — I checked this against Supabase's
  current documented API rather than assuming.
- Sessions: I deliberately did **not** build a per-device list with browser/IP/last-active
  and individual revoke. Supabase Auth doesn't expose that through its public client API —
  the underlying `auth.sessions` table exists but isn't part of the versioned, documented
  surface, and building against it directly is exactly the "fragile custom implementation"
  your own prompt warned against for 2FA. What *is* officially supported and is what's
  built: `supabase.auth.signOut({ scope: 'others' })` — "sign out of every other device,
  keep this one." The security page says this plainly rather than pretending a
  device list exists.
- Confirmation modals added to: job deletion, team member removal, integration
  disconnect — each via the new `ConfirmDialog` component.

### Performance (prompt 14)
- Overview's two "fetch every call / every job ever created" queries are now bounded to a
  120-day window with a 2,000-row cap. Before: unbounded, grows every month forever. After:
  fixed upper bound regardless of account age. **Trade-off**: a job created and left
  `scheduled` for more than 120 days without any update would drop out of the "Needs
  Attention" overdue check — already a data-quality edge case, but worth knowing.
- Call History keeps its full-dataset client-side search/sort/filter (that's the feature —
  sorting every call by sentiment, not just the visible page) but now caps the fetch at
  1,000 rows with a visible "showing most recent 1,000" notice instead of an unbounded
  query. A true database-paginated rewrite would have meant breaking that whole-dataset
  filter/sort behavior, so I didn't do it silently — flagging the trade-off instead.
- Jobs board fetch capped at 2,000 rows (kanban genuinely wants the full active set, so this
  is a safety net rather than a real limit for any normal-sized account).
- I did **not** do a full audit of `AnalyticsPage.tsx` (1,177 lines) memoization, bundle
  code-splitting, or a lucide-react icon audit — those are still open from prompt 14. Given
  everything else in this batch, I prioritized the parts with a real, currently-shipping
  performance bug (unbounded queries) over a general audit pass with no concrete finding
  yet.

### Final design/nav pass (prompt 16)
- Sidebar restructured: Overview / My Jobs / Call History / Leads / Analytics / Insights
  stay top-level; Business Profile / Team / Billing / Integrations / Settings now live
  under a collapsible "Account" section that auto-expands when you're on one of those
  pages. Notifications intentionally has **no** sidebar entry — it's reachable via the bell
  (always visible in the header) and the command palette, so it doesn't add an 11th
  top-level item for something already one click away.
- Cmd+K / Ctrl+K command palette (`CommandPalette.tsx`) for page navigation and searching
  calls/leads/jobs by name or phone. I used Cmd+K only, **not** "/" — "/" is already bound
  on Calls/Leads/Jobs/etc. to focus that page's own search box, and overloading it globally
  would have broken those.
- Every new component uses the existing semantic color tokens (`bg-bg-*`, `text-*`,
  `border`, `accent`, `success-500`, `warning-500`, `danger`) rather than any hardcoded
  color, so dark mode is automatic — verified by grepping for `bg-white`/`bg-gray-`/hex
  codes across every new file; the only two hits (`bg-white` on the 2FA QR code and the
  toggle-switch knob) are intentional and correct in both themes.
- Not done: a full pass over `AnalyticsPage.tsx` and the older pages for stray
  inconsistencies in spacing/animation timing, and I didn't audit loading skeletons on
  every single new surface beyond the ones I built (which do have them).

## 3. Honest list of what's left if you want to keep going

- Full performance audit of `AnalyticsPage.tsx` (memoization of chart aggregations) and a
  bundle-size/code-splitting pass.
- Deciding whether to enable `pg_cron` for the "stale scheduled job" notification case.
- Per-user rate limiting on `ai-assistant-query` if usage costs warrant it.
- A design QA pass specifically in dark mode across every page (I checked the *new*
  components carefully; I didn't re-review the ~11,000 lines of pre-existing pages).

## 4. This pass (bug fix + cleanup + competitor gap check)

- **Fixed a real deployment bug**: `supabase/functions/demo-chat-index.ts` was sitting
  directly in `supabase/functions/` instead of its own `demo-chat/` folder. Supabase Edge
  Functions require `supabase/functions/<name>/index.ts` — as it shipped, `supabase
  functions deploy demo-chat` would not have found this file at all. Moved to
  `supabase/functions/demo-chat/index.ts` (the file's own header comment already said this
  was the intended path).
- **Closed the "no rate limit on `ai-assistant-query`" gap** called out as open in section 3
  above: added `ai_assistant_rate_limit` (migration
  `20260904000000_ai_assistant_rate_limit.sql`) and wired a 30-questions/hour-per-user cap
  into the function, using the same fixed-window approach as `demo_chat_rate_limit` but
  RLS-scoped to the caller's own row instead of a service-role bypass (authenticated users,
  not anonymous visitors).
- **Repo cleanup**: the zip this was exported from had ~90 stale, unused duplicate files
  sitting loose at the project root — older copies of nearly every file in `src/`
  (confirmed by diff: e.g. the root `App.tsx`/`Footer.tsx` were missing routes and features
  present in `src/App.tsx`/`src/components/Footer.tsx`), plus root copies of every SQL
  migration, every public/ asset, and export artifacts (`download`, `download (1)`,
  `config.json`, `.bolt/`, `*.timestamp-*.mjs`, `* - Copy.*`). None of it was reachable from
  the build (`index.html` loads `/src/main.tsx`; the `@` alias in `vite.config.ts` points at
  `/src`), so it was dead weight that only risked someone editing the wrong copy. Removed;
  only the real project tree remains.
- **Static review**: grepped the whole `src/` tree for the usual suspects — leftover
  `console.log`, `@ts-ignore`, `dangerouslySetInnerHTML`, hardcoded API keys/secrets,
  `window.confirm`/`alert` — none found. The codebase was already clean on these.
- **Competitor check** (Podium, Birdeye/Weave-style tools, My AI Front Desk, Frontdesk —
  all missed-call-text-back / AI-receptionist products as of 2026): Vireek's current page
  set already matches or exceeds their public feature list — 24/7 AI call answering,
  automatic missed-call text-back, lead capture + booking, CRM-style Leads/Jobs pipeline,
  a public ROI/missed-call calculator (`CalculatorPage`), a head-to-head `ComparePage`,
  industry-specific landing pages, and a live typed chat demo. Nothing found in this
  research that's a clear, currently-missing must-have; the "what's left" list in section 3
  above (full `AnalyticsPage.tsx` memoization/bundle audit, `pg_cron` decision, dark-mode QA
  across older pages) remains the honest list of open items — this pass didn't attempt
  those, to avoid shipping unverified changes to a 1,177-line file with no way to build or
  run it in this environment (no network access here, so no `npm install`/`build`/
  `typecheck` — same limitation the prior pass flagged; both edited edge functions were
  transpile-checked for syntax, nothing more).

**Before merging**: run `npm install && npm run typecheck && npm run build` locally, apply
the new migration, and redeploy both `demo-chat` (path changed) and `ai-assistant-query`.
