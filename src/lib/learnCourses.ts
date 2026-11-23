// src/lib/learnCourses.ts
//
// Role-based product courses (owner / dispatcher / technician) shown on /dashboard/learn and mirrored in
// docs/academy/*.md. Content is static English (like src/lib/academy.ts); page chrome is translated via the
// `learn` namespace. Every module points at a REAL screen: a test checks each route exists in src/App.tsx, and
// that the docs list every module, route and quiz question. Every quiz statement below was checked against
// the code of that screen (see the "evidence" note in docs/academy/README.md).
//
// This is product training, not a certification: answers ship in the client bundle and the stored score is
// client-reported. Do not use these records as proof of compliance training. [COUNSEL] if ever needed for that.

export type LearnRole = 'owner' | 'dispatcher' | 'technician';
export const LEARN_ROLES: readonly LearnRole[] = ['owner', 'dispatcher', 'technician'];
export const isLearnRole = (v: unknown): v is LearnRole => (LEARN_ROLES as readonly unknown[]).includes(v);

/** Minimum quiz score (percent) that records a module as complete. Mirrored in record_learn_completion(). */
export const PASS_PCT = 80;

export interface LearnQuestion {
  id: string;
  prompt: string;
  options: readonly string[];
  /** Index into options. */
  correct: number;
  explain: string;
}

export interface LearnModule {
  id: string;
  title: string;
  minutes: number;
  /** The real in-app screen this module is about. */
  route: string;
  screen: string;
  objectives: readonly string[];
  steps: readonly string[];
  questions: readonly LearnQuestion[];
}

export interface LearnCourse {
  slug: LearnRole;
  title: string;
  audience: string;
  summary: string;
  modules: readonly LearnModule[];
}

export const LEARN_COURSES: readonly LearnCourse[] = [
  {
    slug: 'owner',
    title: 'Owner course',
    audience: 'Business owners and anyone who manages the account.',
    summary: 'Set up your team and permissions, know where calls are reviewed, keep prices real, and bring data over from another system safely.',
    modules: [
      {
        id: 'owner-team-permissions', title: 'Your team and what each person can see', minutes: 8, route: '/dashboard/team', screen: 'Team',
        objectives: ['Invite team members and understand that permissions are granted per person.', 'Know which permissions gate imports and job visibility.'],
        steps: ['Open Team and review who is active versus invited.', 'Open a member and read their permissions before changing anything.', 'Grant "Edit Business Profile" only to people who should run data imports.', 'Check what a technician without "view all jobs" sees: only jobs assigned to them.'],
        questions: [
          { id: 'q1', prompt: 'A dispatcher needs to run customer imports. Besides the owner, which permission allows it?', options: ['View billing', 'Edit business profile', 'Export data', 'Manage team'], correct: 1, explain: 'Data Imports is restricted to the owner and members with the "Edit Business Profile" permission.' },
          { id: 'q2', prompt: 'A technician has no "view all jobs" permission. What does the Jobs page show them?', options: ['Every job in the account', 'Only jobs assigned to them', 'No jobs at all', 'Only completed jobs'], correct: 1, explain: 'Without that permission the Jobs page only returns jobs assigned to the technician.' },
          { id: 'q3', prompt: 'Who can see job invoice amounts by default?', options: ['Every team member', 'The owner and members with the "view billing" permission', 'Only technicians', 'Only customers'], correct: 1, explain: 'Invoice columns are hidden from team members unless they have the billing permission.' },
        ],
      },
      {
        id: 'owner-calls-review', title: 'Reviewing calls', minutes: 6, route: '/dashboard/calls', screen: 'Call History',
        objectives: ['Find any past call and open its detail.', 'Use call history as the source of truth for what a customer heard.'],
        steps: ['Open Call History from the sidebar.', 'Open a recent call to see its detail page.', 'Use search and filters to find a specific customer or day.'],
        questions: [
          { id: 'q1', prompt: 'Where do you go to look through every past call?', options: ['Dispatch Board', 'Call History', 'Truck stock', 'Open shifts'], correct: 1, explain: 'The Calls page is titled Call History and lists calls; each row opens a call detail page.' },
          { id: 'q2', prompt: 'You want to see what happened on one specific call. What do you open?', options: ['The call’s detail page from Call History', 'The technician’s weekly schedule', 'The price book', 'The Team page'], correct: 0, explain: 'Each call in Call History has its own detail page.' },
        ],
      },
      {
        id: 'owner-price-book', title: 'A price book Sarah can quote from', minutes: 7, route: '/dashboard/price-book', screen: 'Live Price Book',
        objectives: ['Understand why current prices matter on calls.', 'Know the price-book connection options.'],
        steps: ['Open Live Price Book.', 'Review connections: ServiceTitan and Jobber are connectable; you can also maintain prices by hand.', 'Fix anything outdated before turning on quoting.'],
        questions: [
          { id: 'q1', prompt: 'Why keep the price book current?', options: ['So Sarah can quote real prices instead of promising a callback', 'It changes your phone number', 'It schedules technicians', 'It deletes old jobs'], correct: 0, explain: 'The price book gives Sarah real prices to quote on calls.' },
          { id: 'q2', prompt: 'Which systems can the Price Book page connect to?', options: ['ServiceTitan and Jobber', 'Only spreadsheets', 'Only QuickBooks', 'None'], correct: 0, explain: 'The Price Book page has ServiceTitan and Jobber connection controls (Housecall Pro has a connection function too).' },
        ],
      },
      {
        id: 'owner-switching-imports', title: 'Bringing data over safely', minutes: 12, route: '/dashboard/migration', screen: 'Switching to Vireek',
        objectives: ['Import in the right order and keep ID columns.', 'Reconcile imported money to the old system, to the cent.'],
        steps: ['Export customers, then jobs, then invoices, lines, payments and equipment from the old system, keeping ID columns.', 'Import in the same order using Data Imports.', 'Enter the old system’s control totals on Switching to Vireek.', 'Work the validation report until nothing is blocked.'],
        questions: [
          { id: 'q1', prompt: 'Which order should you import in?', options: ['Jobs, then customers', 'Customers, then jobs', 'Payments, then customers', 'It never matters'], correct: 1, explain: 'Jobs and invoices link to customers through the old system’s customer ID, so customers go first.' },
          { id: 'q2', prompt: 'Why keep the ID column in every export?', options: ['It makes re-importing recognise the same record instead of creating duplicates', 'It makes the file smaller', 'It changes prices', 'It is only decoration'], correct: 0, explain: 'The old system’s ID lets Vireek recognise the same record next time.' },
          { id: 'q3', prompt: 'Your imported invoice total is one cent different from the old system’s report. What is the right call?', options: ['Ignore it — it is only a cent', 'Treat it as a failed check and find the cause', 'Change the control total to match', 'Delete the import'], correct: 1, explain: 'Money control totals are compared with zero tolerance; find the cause (rounding, voids, date ranges) instead of adjusting the target.' },
        ],
      },
    ],
  },
  {
    slug: 'dispatcher',
    title: 'Dispatcher course',
    audience: 'Office staff who schedule and assign work.',
    summary: 'Read the Dispatch Board, move jobs through their lifecycle, keep customer records clean, and stay in touch with the field.',
    modules: [
      {
        id: 'dispatch-board', title: 'Reading the Dispatch Board', minutes: 8, route: '/dashboard/dispatch', screen: 'Dispatch Board',
        objectives: ['Know which jobs and technicians appear.', 'Assign by dragging a job to a technician.'],
        steps: ['Open Dispatch Board.', 'Find open jobs: scheduled, en route and in progress.', 'Drag a job onto an active technician to assign it.', 'Watch the board update live as technicians change status.'],
        questions: [
          { id: 'q1', prompt: 'Which jobs does the Dispatch Board show?', options: ['Scheduled, en route and in progress', 'Only completed jobs', 'Every job ever created', 'Only unassigned leads'], correct: 0, explain: 'The board loads jobs whose status is scheduled, en route or in progress.' },
          { id: 'q2', prompt: 'Which technicians are listed?', options: ['Every person invited, accepted or not', 'Only active technicians (invite accepted)', 'Only owners', 'Only technicians with no jobs'], correct: 1, explain: 'The board lists technicians whose invite status is active.' },
          { id: 'q3', prompt: 'How do you assign a job from the board?', options: ['Drag the job onto a technician', 'Email the technician', 'Delete and recreate the job', 'Change the customer type'], correct: 0, explain: 'Jobs are draggable onto technician drop zones.' },
        ],
      },
      {
        id: 'dispatch-jobs-lifecycle', title: 'The job lifecycle', minutes: 6, route: '/dashboard/jobs', screen: 'Jobs',
        objectives: ['Know the four job statuses and their order.', 'Know the default invoice state of a new job.'],
        steps: ['Open Jobs and filter by status.', 'Follow a job: Scheduled → En Route → In Progress → Completed.', 'Open a job to see its invoice status; new jobs start as not sent.'],
        questions: [
          { id: 'q1', prompt: 'What is the correct order of job statuses?', options: ['Scheduled, En Route, In Progress, Completed', 'Completed, Scheduled, En Route, In Progress', 'In Progress, Scheduled, Completed, En Route', 'En Route, Completed, Scheduled, In Progress'], correct: 0, explain: 'The status order is Scheduled, En Route, In Progress, Completed.' },
          { id: 'q2', prompt: 'A technician has just arrived and started work. What is the next status after En Route?', options: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'], correct: 1, explain: 'En Route is followed by In Progress.' },
          { id: 'q3', prompt: 'What is the invoice status of a brand-new job?', options: ['Paid', 'Not sent', 'Overdue', 'Refunded'], correct: 1, explain: 'New jobs default to an invoice status of not sent.' },
        ],
      },
      {
        id: 'dispatch-customers', title: 'Keeping customer records clean', minutes: 7, route: '/dashboard/customers', screen: 'Customers',
        objectives: ['Understand one customer per phone number and email.', 'Know lifecycle stages and customer types.'],
        steps: ['Open Customers and search before creating a new one.', 'Edit the existing record instead of adding a second one.', 'Use lifecycle stage (lead, active, VIP, inactive) and type (residential, commercial).'],
        questions: [
          { id: 'q1', prompt: 'You try to add a customer whose phone number is already on another customer in your account. What happens?', options: ['A second customer is created', 'It is blocked: one customer per phone number per account', 'The first customer is deleted', 'Both are merged silently'], correct: 1, explain: 'Phone numbers and emails are unique per account, which prevents silent duplicates.' },
          { id: 'q2', prompt: 'Which is a customer lifecycle stage?', options: ['VIP', 'Archived-forever', 'Prospect-plus', 'Trial'], correct: 0, explain: 'Lifecycle stages are lead, active, VIP and inactive.' },
        ],
      },
      {
        id: 'dispatch-field-messages', title: 'Messaging the field', minutes: 5, route: '/dashboard/field-messages', screen: 'Field Messages',
        objectives: ['Know that field conversations are organised per job.'],
        steps: ['Open Field Messages: it lists every job thread on the account.', 'Open the thread for a job to read and reply.', 'Technicians read the same thread from their Messages tab.'],
        questions: [
          { id: 'q1', prompt: 'How are technician message threads organised?', options: ['One thread per job', 'One thread per customer phone number', 'One global thread for everyone', 'One thread per invoice'], correct: 0, explain: 'The technician app opens a thread by job (messages/:jobId).' },
        ],
      },
    ],
  },
  {
    slug: 'technician',
    title: 'Technician course',
    audience: 'Field technicians using the mobile app.',
    summary: 'Run your day from Today, work from your weekly schedule even offline, claim open shifts, and keep your truck stocked.',
    modules: [
      {
        id: 'tech-today', title: 'Your day on Today', minutes: 5, route: '/tech/today', screen: 'Today',
        objectives: ['Find today’s jobs and their status.', 'Navigate to a job.'],
        steps: ['Open Today.', 'Tap a job to open its actions, including Navigate.', 'Open the job brief and advance its status as you work: Scheduled, En Route, In Progress, Completed.'],
        questions: [
          { id: 'q1', prompt: 'Which page lists today’s jobs in the technician app?', options: ['Today', 'Truck stock', 'Open shifts', 'Weekly schedule only'], correct: 0, explain: 'Today lists the day’s jobs with their status.' },
          { id: 'q2', prompt: 'You have just left for a job. Which status fits?', options: ['Scheduled', 'En Route', 'In Progress', 'Completed'], correct: 1, explain: 'En Route is the status between Scheduled and In Progress.' },
        ],
      },
      {
        id: 'tech-schedule', title: 'Your weekly schedule, even offline', minutes: 5, route: '/tech/schedule', screen: 'Weekly schedule',
        objectives: ['Read the week at a glance.', 'Know what happens without signal.'],
        steps: ['Open Weekly schedule and pick a day.', 'The next unfinished stop is highlighted for today.', 'If you lose signal, the last loaded schedule stays visible with a notice.'],
        questions: [
          { id: 'q1', prompt: 'You lose mobile signal. What does Weekly schedule do?', options: ['Shows the last loaded schedule with a notice', 'Logs you out', 'Deletes today’s jobs', 'Shows a blank page'], correct: 0, explain: 'The page falls back to cached data and tells you it is offline or showing saved data.' },
        ],
      },
      {
        id: 'tech-open-shifts', title: 'Claiming open shifts', minutes: 6, route: '/tech/job-board', screen: 'Open shifts',
        objectives: ['Read the offer labels.', 'Know what each label means for you.'],
        steps: ['Open Open shifts.', 'Offers labelled "Open to you" can be claimed now; "Opens soon" cannot yet.', 'After you request one it shows "Request sent"; "Yours" means you got it; "Filled" means someone else did.'],
        questions: [
          { id: 'q1', prompt: 'An offer is labelled "Filled". What does that mean?', options: ['It is yours', 'Someone else got it', 'It opens soon', 'You declined it'], correct: 1, explain: 'Filled marks offers you did not win; "Yours" marks the ones you did.' },
          { id: 'q2', prompt: 'Which label means you can claim the shift right now?', options: ['Opens soon', 'Open to you', 'Closed', 'Request sent'], correct: 1, explain: '"Open to you" is the claimable state.' },
        ],
      },
      {
        id: 'tech-truck-stock', title: 'Keeping your truck stocked', minutes: 5, route: '/tech/truck-stock', screen: 'Truck stock',
        objectives: ['Filter to what needs restocking.', 'Know what a missing truck assignment looks like.'],
        steps: ['Open Truck stock.', 'Use the filters: All, Needs restock, Requested.', 'If the page says no truck is assigned yet, ask your dispatcher or owner to assign one.'],
        questions: [
          { id: 'q1', prompt: 'You only want items that are running low. Which filter?', options: ['All', 'Needs restock', 'Requested', 'Yours'], correct: 1, explain: 'The filters are All, Needs restock and Requested.' },
          { id: 'q2', prompt: 'Truck stock says "No truck assigned yet". What is the right next step?', options: ['Ask your dispatcher or owner to assign a truck', 'Reinstall the app', 'Create a new account', 'Nothing can be done'], correct: 0, explain: 'The page is blocked until a truck is assigned to you.' },
        ],
      },
    ],
  },
];

// ------------------------------------------------------------------ pure helpers

export const getCourse = (slug: string): LearnCourse | undefined => LEARN_COURSES.find((c) => c.slug === slug);
export const getModule = (courseSlug: string, moduleId: string): LearnModule | undefined =>
  getCourse(courseSlug)?.modules.find((m) => m.id === moduleId);

export interface QuizScore { correct: number; total: number; pct: number; passed: boolean; wrongQuestionIds: string[] }

/** answers[i] is the chosen option index for question i, or null/undefined when unanswered (counted wrong). */
export function scoreModule(mod: LearnModule, answers: ReadonlyArray<number | null | undefined>): QuizScore {
  const total = mod.questions.length;
  const wrong: string[] = [];
  let correct = 0;
  mod.questions.forEach((q, i) => {
    if (answers[i] === q.correct) correct++; else wrong.push(q.id);
  });
  const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
  return { correct, total, pct, passed: total > 0 && pct >= PASS_PCT, wrongQuestionIds: wrong };
}

export interface CourseProgress { completed: number; total: number; percent: number; done: boolean }

export function courseProgress(course: LearnCourse, completedModuleIds: ReadonlySet<string>): CourseProgress {
  const total = course.modules.length;
  const completed = course.modules.filter((m) => completedModuleIds.has(m.id)).length;
  return { completed, total, percent: total ? Math.round((completed / total) * 100) : 0, done: total > 0 && completed === total };
}

/** Heuristic, not an authorization decision: which course to highlight first for this person. */
export function recommendedCourse(p: { isOwner: boolean; canViewAllJobs: boolean; canManageTeam: boolean }): LearnRole {
  if (p.isOwner) return 'owner';
  if (p.canViewAllJobs || p.canManageTeam) return 'dispatcher';
  return 'technician';
}
