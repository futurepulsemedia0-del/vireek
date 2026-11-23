# Technician course

**Audience:** Field technicians using the mobile app.
**Length:** 4 modules, about 21 minutes.
**In-app:** `/dashboard/learn` (nav label *Learn*) — progress and quizzes are tracked per person.
**Pass mark:** 80% per module quiz.

Run your day from Today, work from your weekly schedule even offline, claim open shifts, and keep your truck stocked.

## Modules

| # | Module | Screen | Route | Minutes |
|---|---|---|---|---|
| 1 | Your day on Today | Today | `/tech/today` | 5 |
| 2 | Your weekly schedule, even offline | Weekly schedule | `/tech/schedule` | 5 |
| 3 | Claiming open shifts | Open shifts | `/tech/job-board` | 6 |
| 4 | Keeping your truck stocked | Truck stock | `/tech/truck-stock` | 5 |

---

## Module 1: Your day on Today

**Screen:** Today — `/tech/today` (module id `tech-today`)

### Objectives

- Find today’s jobs and their status.
- Navigate to a job.

### Do this on the screen

1. Open Today.
2. Tap a job to open its actions, including Navigate.
3. Open the job brief and advance its status as you work: Scheduled, En Route, In Progress, Completed.

### Quiz

**1.1** Which page lists today’s jobs in the technician app?

- A. Today
- B. Truck stock
- C. Open shifts
- D. Weekly schedule only

**1.2** You have just left for a job. Which status fits?

- A. Scheduled
- B. En Route
- C. In Progress
- D. Completed

---

## Module 2: Your weekly schedule, even offline

**Screen:** Weekly schedule — `/tech/schedule` (module id `tech-schedule`)

### Objectives

- Read the week at a glance.
- Know what happens without signal.

### Do this on the screen

1. Open Weekly schedule and pick a day.
2. The next unfinished stop is highlighted for today.
3. If you lose signal, the last loaded schedule stays visible with a notice.

### Quiz

**2.1** You lose mobile signal. What does Weekly schedule do?

- A. Shows the last loaded schedule with a notice
- B. Logs you out
- C. Deletes today’s jobs
- D. Shows a blank page

---

## Module 3: Claiming open shifts

**Screen:** Open shifts — `/tech/job-board` (module id `tech-open-shifts`)

### Objectives

- Read the offer labels.
- Know what each label means for you.

### Do this on the screen

1. Open Open shifts.
2. Offers labelled "Open to you" can be claimed now; "Opens soon" cannot yet.
3. After you request one it shows "Request sent"; "Yours" means you got it; "Filled" means someone else did.

### Quiz

**3.1** An offer is labelled "Filled". What does that mean?

- A. It is yours
- B. Someone else got it
- C. It opens soon
- D. You declined it

**3.2** Which label means you can claim the shift right now?

- A. Opens soon
- B. Open to you
- C. Closed
- D. Request sent

---

## Module 4: Keeping your truck stocked

**Screen:** Truck stock — `/tech/truck-stock` (module id `tech-truck-stock`)

### Objectives

- Filter to what needs restocking.
- Know what a missing truck assignment looks like.

### Do this on the screen

1. Open Truck stock.
2. Use the filters: All, Needs restock, Requested.
3. If the page says no truck is assigned yet, ask your dispatcher or owner to assign one.

### Quiz

**4.1** You only want items that are running low. Which filter?

- A. All
- B. Needs restock
- C. Requested
- D. Yours

**4.2** Truck stock says "No truck assigned yet". What is the right next step?

- A. Ask your dispatcher or owner to assign a truck
- B. Reinstall the app
- C. Create a new account
- D. Nothing can be done

---

## Answer key

| Question | Answer | Why |
|---|---|---|
| 1.1 | A | Today lists the day’s jobs with their status. |
| 1.2 | B | En Route is the status between Scheduled and In Progress. |
| 2.1 | A | The page falls back to cached data and tells you it is offline or showing saved data. |
| 3.1 | B | Filled marks offers you did not win; "Yours" marks the ones you did. |
| 3.2 | B | "Open to you" is the claimable state. |
| 4.1 | B | The filters are All, Needs restock and Requested. |
| 4.2 | A | The page is blocked until a truck is assigned to you. |

## Completion record

In the app this is stored automatically when a quiz is passed (table `learn_module_completions`; the owner sees the team roll-up on the Learn page). For a paper or spreadsheet record, copy this table:

| Person | Role | Module | Date | Score % | Checked by |
|---|---|---|---|---|---|
|  | technician | tech-today |  |  |  |
|  | technician | tech-schedule |  |  |  |
|  | technician | tech-open-shifts |  |  |  |
|  | technician | tech-truck-stock |  |  |  |

> Product training only. Scores are reported by the app and are not proof of compliance or safety training. **[COUNSEL]** before using these records for any regulatory purpose.
