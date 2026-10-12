// src/lib/resources.ts
//
// Registry + pure helpers for the public /resources hub. No I/O here so it is
// trivially unit-testable (see resources.test.ts, which also keeps this registry
// and public/sitemap.xml in sync).
//
// HONESTY NOTE (same standard as WebinarsPage / CaseStudiesPage): an ebook is only
// published once a real file exists. Drop the PDF into public/resources/files/,
// set `fileUrl`, add its sitemap entry, and it appears automatically.

export const SITE_ORIGIN = 'https://vireek.com';

export type ResourceKind = 'ebook' | 'template' | 'calculator';
export type CalculatorId = 'missed-call' | 'estimate-roi';

interface ResourceBase {
  slug: string;
  title: string;
  summary: string;
  description: string;
  highlights: string[];
  tags: string[];
  /** ISO date (YYYY-MM-DD). */
  updated: string;
}

export interface TemplateResource extends ResourceBase {
  kind: 'template';
  fileName: string;
  body: string;
}

export interface CalculatorResource extends ResourceBase {
  kind: 'calculator';
  calculator: CalculatorId;
}

export interface EbookResource extends ResourceBase {
  kind: 'ebook';
  /** null = not published yet (hidden from the hub and sitemap). */
  fileUrl: string | null;
  pages?: number;
}

export type Resource = TemplateResource | CalculatorResource | EbookResource;

export const KIND_LABEL: Record<ResourceKind, string> = {
  ebook: 'Ebook',
  template: 'Template',
  calculator: 'Calculator',
};

export const KIND_PLURAL: Record<ResourceKind, string> = {
  ebook: 'Ebooks',
  template: 'Templates',
  calculator: 'Calculators',
};

const MISSED_CALL_TEXT_BACK = `MISSED-CALL TEXT-BACK SCRIPTS
Send within 60 seconds of a missed call. Keep it short, sound human, and ask ONE question.

1) During business hours
Hi, this is [Your Name] at [Business Name]. Sorry we missed your call! What can we help with? We'll reply right away.

2) After hours
Hi, thanks for calling [Business Name]. We're closed until [Opening Time], but I have your number. Reply with what's going on and we'll get back to you first thing.

3) Emergency (no heat, burst pipe, no power)
This is [Business Name]. Is this an emergency? Reply YES and we'll call you back within 10 minutes, or call [Emergency Line] now.

4) They left a voicemail
Hi [Name], it's [Your Name] at [Business Name]. Got your voicemail. Is [Time] today or tomorrow better for a quick call back?

5) They asked for an estimate
Hi [Name], thanks for reaching out to [Business Name]. To send an accurate estimate, can you reply with your address and a short description (or a photo) of the job?

6) Returning customer
Hi [Name], it's [Business Name]. Sorry we missed you! Is this about your last visit, or something new?

TIPS
- One question per message. Two questions halve your reply rate.
- Never start with a long apology. Be useful in the first line.
- If they reply, call them within 5 minutes. Speed wins the job.
- Stop messaging as soon as they reply or ask you to stop.
`;

const CALL_INTAKE_CHECKLIST = `NEW-CALL INTAKE CHECKLIST
Capture these on every inbound call so dispatch never has to call back for basics.

CONTACT
[ ] Full name
[ ] Best callback number
[ ] Email (for confirmations and invoices)

LOCATION
[ ] Service address (with unit / gate code)
[ ] Own or rent? If renting: landlord approval needed?

THE PROBLEM
[ ] What is happening, in their words?
[ ] When did it start?
[ ] Anything already tried?
[ ] Make / model / age of the equipment (if known)

URGENCY
[ ] Safety risk (gas smell, sparking, flooding)? -> escalate immediately
[ ] No heat / no cooling / no water / no power?
[ ] Is anyone vulnerable at home (infant, elderly, medical equipment)?

SCHEDULING
[ ] Preferred day and window
[ ] Anyone available to give access?
[ ] Pets on site?

BUSINESS
[ ] How did they hear about us?
[ ] Existing customer? (check history)
[ ] Quote or diagnostic fee explained and accepted?

CLOSE THE CALL
[ ] Repeat back address, time and phone number
[ ] Tell them what happens next (text confirmation, technician call-ahead)
`;

const ESTIMATE_FOLLOW_UP = `ESTIMATE FOLLOW-UP SEQUENCE
Most estimates are lost to silence, not price. Four short touches over two weeks.

DAY 1 (same day you send the estimate)
Hi [Name], it's [Your Name] at [Business Name]. I just sent your estimate for [Job]. Happy to walk you through it. When is a good time for a quick call?

DAY 3
Hi [Name], checking the estimate for [Job] landed OK. Any questions about the scope or the options? I can adjust it if something doesn't fit.

DAY 7
Hi [Name], quick note: we have openings on [Date] and [Date] if you'd like to get [Job] on the calendar. Want me to hold one for you?

DAY 14 (the polite close)
Hi [Name], I'll close out your estimate for [Job] so it doesn't clutter your inbox. If timing changes, reply any time and I'll pick it right back up.

TIPS
- Always offer a next step (a call, two dates), never just "any questions?".
- Reference the specific job so it never reads like a mass text.
- Stop the sequence the moment they reply, book, or decline.
`;

export const ALL_RESOURCES: Resource[] = [
  {
    slug: 'missed-call-revenue-calculator',
    kind: 'calculator',
    calculator: 'missed-call',
    title: 'Missed-Call Revenue Calculator',
    summary: 'See how much revenue unanswered calls cost your business every month.',
    description:
      'Enter your weekly call volume, how many go unanswered, your average job value and your close rate. The calculator shows the jobs and revenue you are leaving on the table each month.',
    highlights: [
      'Four sliders, instant monthly results',
      'Uses your own numbers, nothing is stored',
      'Built for home service businesses',
    ],
    tags: ['missed calls', 'revenue', 'roi', 'calculator'],
    updated: '2026-10-09',
  },
  {
    slug: 'estimate-follow-up-roi-calculator',
    kind: 'calculator',
    calculator: 'estimate-roi',
    title: 'Estimate Follow-Up ROI Calculator',
    summary: 'Estimate the revenue hiding in estimates that go cold with no follow-up.',
    description:
      'Enter your team size, estimates sent per month, average ticket and the share that go cold. See how many estimates and how much monthly revenue consistent follow-up could recover.',
    highlights: [
      'Estimates recovered per month',
      'Monthly revenue opportunity',
      'Adjust every assumption yourself',
    ],
    tags: ['estimates', 'follow-up', 'roi', 'calculator'],
    updated: '2026-10-09',
  },
  {
    slug: 'missed-call-text-back-scripts',
    kind: 'template',
    fileName: 'missed-call-text-back-scripts.txt',
    body: MISSED_CALL_TEXT_BACK,
    title: 'Missed-Call Text-Back Scripts',
    summary: 'Six ready-to-send texts that turn missed calls into booked jobs.',
    description:
      'Copy-and-paste text messages for business hours, after hours, emergencies, voicemails, estimate requests and returning customers, plus the rules that keep reply rates high.',
    highlights: [
      '6 scripts for the most common missed-call situations',
      'Placeholders you fill in once and reuse',
      'Copy to clipboard or download as a text file',
    ],
    tags: ['sms', 'text', 'scripts', 'missed calls', 'template'],
    updated: '2026-10-09',
  },
  {
    slug: 'new-call-intake-checklist',
    kind: 'template',
    fileName: 'new-call-intake-checklist.txt',
    body: CALL_INTAKE_CHECKLIST,
    title: 'New-Call Intake Checklist',
    summary: 'Everything to capture on an inbound call so dispatch never calls back for basics.',
    description:
      'A one-page checklist covering contact details, location, the problem, urgency, scheduling and how to close the call, so every booking arrives complete.',
    highlights: [
      'Safety and urgency screening built in',
      'Works for phone, front desk or AI receptionist',
      'Copy to clipboard or download as a text file',
    ],
    tags: ['intake', 'checklist', 'dispatch', 'calls', 'template'],
    updated: '2026-10-09',
  },
  {
    slug: 'estimate-follow-up-sequence',
    kind: 'template',
    fileName: 'estimate-follow-up-sequence.txt',
    body: ESTIMATE_FOLLOW_UP,
    title: 'Estimate Follow-Up Sequence',
    summary: 'A four-message, two-week sequence that wins back silent estimates.',
    description:
      'Four short messages for day 1, 3, 7 and 14 after you send an estimate, with the rules for when to stop, so follow-up feels helpful instead of pushy.',
    highlights: [
      'Day 1, 3, 7 and 14 messages',
      'Every message offers a clear next step',
      'Copy to clipboard or download as a text file',
    ],
    tags: ['estimates', 'follow-up', 'sms', 'email', 'template'],
    updated: '2026-10-09',
  },
  // Example ebook entry. Uncomment ONLY after the PDF exists in
  // public/resources/files/ and its URLs are in public/sitemap.xml:
  // {
  //   slug: 'missed-call-playbook',
  //   kind: 'ebook',
  //   fileUrl: '/resources/files/missed-call-playbook.pdf',
  //   pages: 24,
  //   title: 'The Missed-Call Playbook',
  //   summary: '...',
  //   description: '...',
  //   highlights: ['...'],
  //   tags: ['missed calls', 'ebook'],
  //   updated: '2026-10-09',
  // },
];

// ------------------------------------------------------------------
// Selectors
// ------------------------------------------------------------------

export function isPublishable(resource: Resource): boolean {
  return resource.kind !== 'ebook' || !!resource.fileUrl;
}

export function publishedResources(list: Resource[] = ALL_RESOURCES): Resource[] {
  return list.filter(isPublishable);
}

export function getPublishedResource(slug: string, list: Resource[] = ALL_RESOURCES): Resource | undefined {
  return publishedResources(list).find((r) => r.slug === slug);
}

export function filterResources(
  list: Resource[],
  opts: { kind: 'all' | ResourceKind; query: string },
): Resource[] {
  const tokens = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((r) => {
    if (opts.kind !== 'all' && r.kind !== opts.kind) return false;
    if (tokens.length === 0) return true;
    const haystack = `${r.title} ${r.summary} ${r.tags.join(' ')}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

export const resourcePath = (slug: string): string => `/resources/${slug}`;
export const resourceUrl = (slug: string): string => `${SITE_ORIGIN}/resources/${slug}`;

// ------------------------------------------------------------------
// Email + unlock (pure parts)
// ------------------------------------------------------------------

export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const UNLOCK_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function serializeUnlock(now: number): string {
  return JSON.stringify({ t: now });
}

export function parseUnlock(raw: string | null, now: number): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { t?: unknown };
    return typeof parsed.t === 'number' && parsed.t <= now + 60_000 && now - parsed.t < UNLOCK_TTL_MS;
  } catch {
    return false;
  }
}

export type CaptureFailure = 'invalid_email' | 'rate_limited' | 'network' | 'unknown';

export function mapCaptureError(message: string | undefined): CaptureFailure {
  const m = (message ?? '').toLowerCase();
  if (m.includes('invalid_email')) return 'invalid_email';
  if (m.includes('rate_limited')) return 'rate_limited';
  if (m.includes('failed to fetch') || m.includes('network')) return 'network';
  return 'unknown';
}

// ------------------------------------------------------------------
// Structured data
// ------------------------------------------------------------------

export function resourceJsonLd(resource: Resource): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: resource.title,
    description: resource.summary,
    url: resourceUrl(resource.slug),
    dateModified: resource.updated,
    isAccessibleForFree: true,
    publisher: { '@type': 'Organization', name: 'Vireek', url: SITE_ORIGIN },
  };
}

export function hubJsonLd(list: Resource[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Free Resources for Home Service Businesses — Vireek',
    url: `${SITE_ORIGIN}/resources`,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: list.map((r, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: r.title,
        url: resourceUrl(r.slug),
      })),
    },
  };
}
