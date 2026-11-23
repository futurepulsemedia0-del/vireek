# Owner course

**Audience:** Business owners and anyone who manages the account.
**Length:** 4 modules, about 33 minutes.
**In-app:** `/dashboard/learn` (nav label *Learn*) — progress and quizzes are tracked per person.
**Pass mark:** 80% per module quiz.

Set up your team and permissions, know where calls are reviewed, keep prices real, and bring data over from another system safely.

## Modules

| # | Module | Screen | Route | Minutes |
|---|---|---|---|---|
| 1 | Your team and what each person can see | Team | `/dashboard/team` | 8 |
| 2 | Reviewing calls | Call History | `/dashboard/calls` | 6 |
| 3 | A price book Sarah can quote from | Live Price Book | `/dashboard/price-book` | 7 |
| 4 | Bringing data over safely | Switching to Vireek | `/dashboard/migration` | 12 |

---

## Module 1: Your team and what each person can see

**Screen:** Team — `/dashboard/team` (module id `owner-team-permissions`)

### Objectives

- Invite team members and understand that permissions are granted per person.
- Know which permissions gate imports and job visibility.

### Do this on the screen

1. Open Team and review who is active versus invited.
2. Open a member and read their permissions before changing anything.
3. Grant "Edit Business Profile" only to people who should run data imports.
4. Check what a technician without "view all jobs" sees: only jobs assigned to them.

### Quiz

**1.1** A dispatcher needs to run customer imports. Besides the owner, which permission allows it?

- A. View billing
- B. Edit business profile
- C. Export data
- D. Manage team

**1.2** A technician has no "view all jobs" permission. What does the Jobs page show them?

- A. Every job in the account
- B. Only jobs assigned to them
- C. No jobs at all
- D. Only completed jobs

**1.3** Who can see job invoice amounts by default?

- A. Every team member
- B. The owner and members with the "view billing" permission
- C. Only technicians
- D. Only customers

---

## Module 2: Reviewing calls

**Screen:** Call History — `/dashboard/calls` (module id `owner-calls-review`)

### Objectives

- Find any past call and open its detail.
- Use call history as the source of truth for what a customer heard.

### Do this on the screen

1. Open Call History from the sidebar.
2. Open a recent call to see its detail page.
3. Use search and filters to find a specific customer or day.

### Quiz

**2.1** Where do you go to look through every past call?

- A. Dispatch Board
- B. Call History
- C. Truck stock
- D. Open shifts

**2.2** You want to see what happened on one specific call. What do you open?

- A. The call’s detail page from Call History
- B. The technician’s weekly schedule
- C. The price book
- D. The Team page

---

## Module 3: A price book Sarah can quote from

**Screen:** Live Price Book — `/dashboard/price-book` (module id `owner-price-book`)

### Objectives

- Understand why current prices matter on calls.
- Know the price-book connection options.

### Do this on the screen

1. Open Live Price Book.
2. Review connections: ServiceTitan and Jobber are connectable; you can also maintain prices by hand.
3. Fix anything outdated before turning on quoting.

### Quiz

**3.1** Why keep the price book current?

- A. So Sarah can quote real prices instead of promising a callback
- B. It changes your phone number
- C. It schedules technicians
- D. It deletes old jobs

**3.2** Which systems can the Price Book page connect to?

- A. ServiceTitan and Jobber
- B. Only spreadsheets
- C. Only QuickBooks
- D. None

---

## Module 4: Bringing data over safely

**Screen:** Switching to Vireek — `/dashboard/migration` (module id `owner-switching-imports`)

### Objectives

- Import in the right order and keep ID columns.
- Reconcile imported money to the old system, to the cent.

### Do this on the screen

1. Export customers, then jobs, then invoices, lines, payments and equipment from the old system, keeping ID columns.
2. Import in the same order using Data Imports.
3. Enter the old system’s control totals on Switching to Vireek.
4. Work the validation report until nothing is blocked.

### Quiz

**4.1** Which order should you import in?

- A. Jobs, then customers
- B. Customers, then jobs
- C. Payments, then customers
- D. It never matters

**4.2** Why keep the ID column in every export?

- A. It makes re-importing recognise the same record instead of creating duplicates
- B. It makes the file smaller
- C. It changes prices
- D. It is only decoration

**4.3** Your imported invoice total is one cent different from the old system’s report. What is the right call?

- A. Ignore it — it is only a cent
- B. Treat it as a failed check and find the cause
- C. Change the control total to match
- D. Delete the import

---

## Answer key

| Question | Answer | Why |
|---|---|---|
| 1.1 | B | Data Imports is restricted to the owner and members with the "Edit Business Profile" permission. |
| 1.2 | B | Without that permission the Jobs page only returns jobs assigned to the technician. |
| 1.3 | B | Invoice columns are hidden from team members unless they have the billing permission. |
| 2.1 | B | The Calls page is titled Call History and lists calls; each row opens a call detail page. |
| 2.2 | A | Each call in Call History has its own detail page. |
| 3.1 | A | The price book gives Sarah real prices to quote on calls. |
| 3.2 | A | The Price Book page has ServiceTitan and Jobber connection controls (Housecall Pro has a connection function too). |
| 4.1 | B | Jobs and invoices link to customers through the old system’s customer ID, so customers go first. |
| 4.2 | A | The old system’s ID lets Vireek recognise the same record next time. |
| 4.3 | B | Money control totals are compared with zero tolerance; find the cause (rounding, voids, date ranges) instead of adjusting the target. |

## Completion record

In the app this is stored automatically when a quiz is passed (table `learn_module_completions`; the owner sees the team roll-up on the Learn page). For a paper or spreadsheet record, copy this table:

| Person | Role | Module | Date | Score % | Checked by |
|---|---|---|---|---|---|
|  | owner | owner-team-permissions |  |  |  |
|  | owner | owner-calls-review |  |  |  |
|  | owner | owner-price-book |  |  |  |
|  | owner | owner-switching-imports |  |  |  |

> Product training only. Scores are reported by the app and are not proof of compliance or safety training. **[COUNSEL]** before using these records for any regulatory purpose.
