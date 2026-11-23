# Dispatcher course

**Audience:** Office staff who schedule and assign work.
**Length:** 4 modules, about 26 minutes.
**In-app:** `/dashboard/learn` (nav label *Learn*) — progress and quizzes are tracked per person.
**Pass mark:** 80% per module quiz.

Read the Dispatch Board, move jobs through their lifecycle, keep customer records clean, and stay in touch with the field.

## Modules

| # | Module | Screen | Route | Minutes |
|---|---|---|---|---|
| 1 | Reading the Dispatch Board | Dispatch Board | `/dashboard/dispatch` | 8 |
| 2 | The job lifecycle | Jobs | `/dashboard/jobs` | 6 |
| 3 | Keeping customer records clean | Customers | `/dashboard/customers` | 7 |
| 4 | Messaging the field | Field Messages | `/dashboard/field-messages` | 5 |

---

## Module 1: Reading the Dispatch Board

**Screen:** Dispatch Board — `/dashboard/dispatch` (module id `dispatch-board`)

### Objectives

- Know which jobs and technicians appear.
- Assign by dragging a job to a technician.

### Do this on the screen

1. Open Dispatch Board.
2. Find open jobs: scheduled, en route and in progress.
3. Drag a job onto an active technician to assign it.
4. Watch the board update live as technicians change status.

### Quiz

**1.1** Which jobs does the Dispatch Board show?

- A. Scheduled, en route and in progress
- B. Only completed jobs
- C. Every job ever created
- D. Only unassigned leads

**1.2** Which technicians are listed?

- A. Every person invited, accepted or not
- B. Only active technicians (invite accepted)
- C. Only owners
- D. Only technicians with no jobs

**1.3** How do you assign a job from the board?

- A. Drag the job onto a technician
- B. Email the technician
- C. Delete and recreate the job
- D. Change the customer type

---

## Module 2: The job lifecycle

**Screen:** Jobs — `/dashboard/jobs` (module id `dispatch-jobs-lifecycle`)

### Objectives

- Know the four job statuses and their order.
- Know the default invoice state of a new job.

### Do this on the screen

1. Open Jobs and filter by status.
2. Follow a job: Scheduled → En Route → In Progress → Completed.
3. Open a job to see its invoice status; new jobs start as not sent.

### Quiz

**2.1** What is the correct order of job statuses?

- A. Scheduled, En Route, In Progress, Completed
- B. Completed, Scheduled, En Route, In Progress
- C. In Progress, Scheduled, Completed, En Route
- D. En Route, Completed, Scheduled, In Progress

**2.2** A technician has just arrived and started work. What is the next status after En Route?

- A. Scheduled
- B. In Progress
- C. Completed
- D. Cancelled

**2.3** What is the invoice status of a brand-new job?

- A. Paid
- B. Not sent
- C. Overdue
- D. Refunded

---

## Module 3: Keeping customer records clean

**Screen:** Customers — `/dashboard/customers` (module id `dispatch-customers`)

### Objectives

- Understand one customer per phone number and email.
- Know lifecycle stages and customer types.

### Do this on the screen

1. Open Customers and search before creating a new one.
2. Edit the existing record instead of adding a second one.
3. Use lifecycle stage (lead, active, VIP, inactive) and type (residential, commercial).

### Quiz

**3.1** You try to add a customer whose phone number is already on another customer in your account. What happens?

- A. A second customer is created
- B. It is blocked: one customer per phone number per account
- C. The first customer is deleted
- D. Both are merged silently

**3.2** Which is a customer lifecycle stage?

- A. VIP
- B. Archived-forever
- C. Prospect-plus
- D. Trial

---

## Module 4: Messaging the field

**Screen:** Field Messages — `/dashboard/field-messages` (module id `dispatch-field-messages`)

### Objectives

- Know that field conversations are organised per job.

### Do this on the screen

1. Open Field Messages: it lists every job thread on the account.
2. Open the thread for a job to read and reply.
3. Technicians read the same thread from their Messages tab.

### Quiz

**4.1** How are technician message threads organised?

- A. One thread per job
- B. One thread per customer phone number
- C. One global thread for everyone
- D. One thread per invoice

---

## Answer key

| Question | Answer | Why |
|---|---|---|
| 1.1 | A | The board loads jobs whose status is scheduled, en route or in progress. |
| 1.2 | B | The board lists technicians whose invite status is active. |
| 1.3 | A | Jobs are draggable onto technician drop zones. |
| 2.1 | A | The status order is Scheduled, En Route, In Progress, Completed. |
| 2.2 | B | En Route is followed by In Progress. |
| 2.3 | B | New jobs default to an invoice status of not sent. |
| 3.1 | B | Phone numbers and emails are unique per account, which prevents silent duplicates. |
| 3.2 | A | Lifecycle stages are lead, active, VIP and inactive. |
| 4.1 | A | The technician app opens a thread by job (messages/:jobId). |

## Completion record

In the app this is stored automatically when a quiz is passed (table `learn_module_completions`; the owner sees the team roll-up on the Learn page). For a paper or spreadsheet record, copy this table:

| Person | Role | Module | Date | Score % | Checked by |
|---|---|---|---|---|---|
|  | dispatcher | dispatch-board |  |  |  |
|  | dispatcher | dispatch-jobs-lifecycle |  |  |  |
|  | dispatcher | dispatch-customers |  |  |  |
|  | dispatcher | dispatch-field-messages |  |  |  |

> Product training only. Scores are reported by the app and are not proof of compliance or safety training. **[COUNSEL]** before using these records for any regulatory purpose.
