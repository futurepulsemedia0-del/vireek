# Vireek role courses (customer academy)

Three short courses — [Owner](./owner-course.md), [Dispatcher](./dispatcher-course.md), [Technician](./technician-course.md) — each module tied to a **real product screen**, with a quiz and a completion record.

## How this relates to what already exists

| Existing | What it is | Relation |
|---|---|---|
| `/academy` (`AcademyPage`, `src/lib/academy.ts`, `academy_progress`, `academy_badges`) | Public video lessons (Getting Started, Running Your Day) with a completion badge. Video URLs are still placeholders. | **Untouched.** Role courses use separate data so the badge's "all lessons" count is not disturbed. |
| `/dashboard/training` (`SopTrainingPage`, `sop_*` tables) | Company SOP reading, quizzes and acknowledgements assigned by an owner. | Different purpose (your own SOPs). Not duplicated. |
| Partner academy (`partnerAcademy.ts`) | Partner certification. | Unrelated. |

New here: role-based courses, a per-person completion record, and the owner's team roll-up, on **`/dashboard/learn`**.

## Where things live

| Piece | Path |
|---|---|
| Course data (single source of truth) | `src/lib/learnCourses.ts` |
| Page | `src/pages/LearnPage.tsx` (route `/dashboard/learn`, nav label *Learn*) |
| Client API | `src/lib/learnApi.ts` |
| UI strings (i18n namespace `learn`) | `src/locales/en/learn.json`, `src/i18n/learnNamespace.ts` |
| DB | `supabase/migrations/20290308000000_learn_completions.sql` |
| Course docs | `docs/academy/*-course.md` |
| Tests | `src/lib/learnCourses.test.ts`, `src/lib/learnCompletionsMigration.test.ts` |

## Completion record

**In the app** — table `learn_module_completions`: one row per learner + course + module, written through `record_learn_completion()` only when the quiz score is at least the pass mark (80%). Re-takes keep the best score and count attempts. A learner reads their own rows; the account owner reads the whole account's rows and sees a per-person roll-up (`learn_team_completion_summary()`, owner-only). There is no delete policy.

**On paper / in a spreadsheet** — each course doc ends with a ready-to-copy record table.

**Limits (be honest with customers):** the quiz runs in the browser, so answers ship in the bundle and the score is client-reported. This is product training bookkeeping — not proof of compliance, safety or regulatory training. **[COUNSEL]** before using it that way.

## Evidence for quiz content

Every quiz statement was checked against the code of the screen it describes (examples): job status order in `src/lib/technicianOS.ts`; Dispatch Board job/technician filters and drag-and-drop in `DispatchBoardPage.tsx`; open-shift labels in `TechnicianJobBoardPage.tsx`; truck-stock filters in `TruckStockPage.tsx`; per-job message threads in `FieldMessagesPage.tsx`; jobs visibility rule in `JobsPage.tsx`; customer uniqueness in `20260918000000_create_customers.sql`; the imports permission in `can_run_data_imports()`. UI wording can change — if a screen changes, update the module, its docs and the test fixtures together.

## Adding or changing a module

1. Edit `src/lib/learnCourses.ts` (route must exist in `src/App.tsx`).
2. Update the matching `docs/academy/<role>-course.md` (module heading, route, every quiz prompt, answer-key row). The test `learnCourses.test.ts` fails when docs and data drift.
3. Module ids are stored in the database: never rename an id that has been released; add a new module instead.

## Not included
Translated course content (page chrome is translatable; course text is English), video, certificates, and server-side answer checking.
