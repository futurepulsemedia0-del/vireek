import { describe, it, expect } from 'vitest';
import { computeSnapshot, type RawData } from './changesSinceYesterday';
import {
  allowedSections,
  canSeeBilling,
  composeBriefing,
  daysBetween,
  DEFAULT_PREFS,
  effectiveSections,
  isDue,
  localDayBoundsUtc,
  localParts,
  sanitizePrefs,
  scheduleRisks,
  summarizeUnpaid,
  toEmail,
  toPlainText,
  toPushPayload,
  type BriefingInputs,
  type BriefingJob,
  type BriefingRecipient,
} from './dailyBriefing';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 12, 11, 5); // 07:05 EDT, 2026-10-12
const iso = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 12, h, m)).toISOString(); // UTC hours
const emptyRaw: RawData = {
  invoices: [],
  calls: [],
  jobsCreated: [],
  jobsScheduled: [],
  reviews: [],
  dailyCapacity: null,
};
const job = (o: Partial<BriefingJob> = {}): BriefingJob => ({
  id: Math.random().toString(36),
  customer_name: 'Ann',
  service_type: 'AC',
  scheduled_datetime: iso(13),
  job_status: 'scheduled',
  assigned_technician_id: 't1',
  ...o,
});
const base = (o: Partial<BriefingInputs> = {}): BriefingInputs => ({
  now: NOW,
  timezone: TZ,
  snapshot: computeSnapshot(emptyRaw, NOW),
  jobsToday: [],
  dailyCapacity: null,
  emergencyCalls: [],
  unpaidInvoices: [],
  expiring: [],
  insights: [],
  ...o,
});
const owner: BriefingRecipient = {
  role: 'owner',
  name: 'Sam Lee',
  canViewBilling: true,
  teamMemberId: null,
};
const inv = (o = {}) => ({
  status: 'sent',
  customer_name: 'Bob',
  due_date: '2026-10-01',
  line_items: [{ quantity: 1, unit_price_cents: 100_000 }],
  tax_percent: 0,
  ...o,
});

describe('time helpers', () => {
  it('computes local date/hour in the recipient timezone', () => {
    expect(localParts(NOW, TZ)).toMatchObject({ date: '2026-10-12', hour: 7 });
    expect(localParts(NOW, 'Asia/Baku')).toMatchObject({ date: '2026-10-12', hour: 15 });
  });
  it('falls back to the default timezone for an invalid one', () => {
    expect(localParts(NOW, 'Not/AZone').hour).toBe(7);
  });
  it('returns a 24h day on a normal day and 23h/25h on DST days', () => {
    const d = localDayBoundsUtc(NOW, TZ);
    expect(d.end - d.start).toBe(24 * 3_600_000);
    const spring = localDayBoundsUtc(Date.UTC(2026, 2, 8, 15), TZ); // US spring-forward
    expect(spring.end - spring.start).toBe(23 * 3_600_000);
    const fall = localDayBoundsUtc(Date.UTC(2026, 10, 1, 15), TZ);
    expect(fall.end - fall.start).toBe(25 * 3_600_000);
  });
  it('daysBetween is calendar-based', () => {
    expect(daysBetween('2026-10-01', '2026-10-12')).toBe(11);
  });
});

describe('isDue / prefs', () => {
  const p = { ...DEFAULT_PREFS };
  it('is due inside the send hour window', () => {
    expect(isDue(p, NOW)).toBe(true);
    expect(isDue(p, NOW + 3_600_000)).toBe(true); // 08:05 catch-up
    expect(isDue(p, NOW + 3 * 3_600_000)).toBe(false); // 10:05 too late
    expect(isDue(p, NOW - 3_600_000)).toBe(false); // 06:05 too early
  });
  it('is not due when disabled or already sent today', () => {
    expect(isDue({ ...p, enabled: false }, NOW)).toBe(false);
    expect(isDue({ ...p, lastSentOn: '2026-10-12' }, NOW)).toBe(false);
    expect(isDue({ ...p, lastSentOn: '2026-10-11' }, NOW)).toBe(true);
  });
  it('honours each recipient timezone', () => {
    expect(isDue({ ...p, timezone: 'Asia/Baku' }, NOW)).toBe(false); // 15:05 there
    expect(isDue({ ...p, timezone: 'Asia/Baku', sendHour: 15 }, NOW)).toBe(true);
  });
  it('never wraps past local midnight', () => {
    const late = { ...p, sendHour: 23 };
    expect(isDue(late, Date.UTC(2026, 9, 13, 3, 10))).toBe(true); // 23:10 EDT
    expect(isDue(late, Date.UTC(2026, 9, 13, 4, 10))).toBe(false); // 00:10 EDT next day: window closed
  });
  it('sanitizes untrusted input', () => {
    const s = sanitizePrefs({
      sendHour: 99,
      timezone: 'bogus',
      sections: ['nope' as never],
      channels: { push: false } as never,
    });
    expect(s).toMatchObject({ sendHour: 7, timezone: TZ, sections: null });
    expect(s.channels).toEqual({ push: false, email: true, inApp: true });
  });
});

describe('role content', () => {
  it('gives each role its own sections and hides billing without permission', () => {
    expect(allowedSections('owner', true)).toContain('unpaid');
    expect(allowedSections('member', true)).not.toContain('unpaid');
    expect(allowedSections('admin', false)).not.toContain('unpaid');
    expect(allowedSections('technician', false)).toEqual(['schedule', 'emergencies']);
  });
  it('user selection can narrow but never widen', () => {
    expect(effectiveSections('technician', false, ['unpaid', 'schedule'])).toEqual(['schedule']);
    expect(effectiveSections('owner', true, ['actions'])).toEqual(['actions']);
    expect(effectiveSections('technician', false, ['unpaid'])).toEqual(['schedule', 'emergencies']);
  });
  it('canSeeBilling', () => {
    expect(canSeeBilling('owner')).toBe(true);
    expect(canSeeBilling('member', { can_view_billing: true })).toBe(true);
    expect(canSeeBilling('technician', null)).toBe(false);
  });
});

describe('schedule risks', () => {
  it('flags unassigned jobs, double-booking and overbooking; ignores finished jobs', () => {
    const jobs = [
      job({ assigned_technician_id: null }),
      job({ assigned_technician_id: 't1', scheduled_datetime: iso(14, 0) }),
      job({ assigned_technician_id: 't1', scheduled_datetime: iso(14, 30) }),
      job({ job_status: 'completed', assigned_technician_id: null }),
    ];
    const kinds = scheduleRisks(jobs, 3, TZ)
      .map((r) => r.kind)
      .sort();
    expect(kinds).toEqual(['conflict', 'overbooked', 'unassigned']);
  });
  it('reports nothing for a clean day', () => {
    expect(scheduleRisks([job(), job({ assigned_technician_id: 't2' })], 6, TZ)).toEqual([]);
  });
});

describe('summarizeUnpaid', () => {
  it('totals outstanding, overdue and the oldest customer; skips paid/void/draft', () => {
    const u = summarizeUnpaid(
      [inv(), inv({ due_date: '2026-10-20' }), inv({ status: 'paid' }), inv({ status: 'void' })],
      '2026-10-12',
    );
    expect(u).toMatchObject({
      count: 2,
      totalCents: 200_000,
      overdueCount: 1,
      overdueCents: 100_000,
    });
    expect(u.oldest).toMatchObject({ customer: 'Bob', daysLate: 11 });
  });
});

describe('composeBriefing', () => {
  it('is all-clear and calm when nothing is wrong', () => {
    const b = composeBriefing(base(), owner);
    expect(b.severity).toBe('calm');
    expect(b.headline).toMatch(/All clear/);
    expect(b.sections.map((s) => s.key)).toEqual([
      'yesterday',
      'schedule',
      'emergencies',
      'unpaid',
      'expiring',
      'actions',
    ]);
  });

  it('escalates to urgent for unhandled emergencies and leads actions with them', () => {
    const b = composeBriefing(
      base({
        emergencyCalls: [{ id: 'c1', caller_name: 'Zoe', call_datetime: iso(10), has_job: false }],
        insights: [{ title: 'x', recommended_action: 'Add on-call coverage Fridays', priority: 4 }],
      }),
      owner,
    );
    expect(b.severity).toBe('urgent');
    expect(b.headline).toMatch(/1 unhandled emergency/);
    const actions = b.sections.find((s) => s.key === 'actions')!.items;
    expect(actions[0]).toMatchObject({ tag: 'Rule' });
    expect(actions[1]).toMatchObject({ tag: 'AI', text: 'Add on-call coverage Fridays' });
  });

  it('caps actions at 3, prefers higher-priority AI, and dedupes', () => {
    const insights = [1, 2, 3, 4]
      .map((p) => ({ title: `t${p}`, recommended_action: `Do thing ${p}`, priority: p }))
      .concat([{ title: 'dup', recommended_action: 'do THING 4!', priority: 5 }]);
    const items = composeBriefing(base({ insights }), owner).sections.find(
      (s) => s.key === 'actions',
    )!.items;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.text)).toEqual(['do THING 4!', 'Do thing 3', 'Do thing 2']);
  });

  it('falls back to rule actions when the AI layer returned nothing', () => {
    const b = composeBriefing(
      base({ jobsToday: [job({ assigned_technician_id: null })], unpaidInvoices: [inv()] }),
      owner,
    );
    const texts = b.sections.find((s) => s.key === 'actions')!.items.map((i) => i.text);
    expect(texts.some((t) => /unassigned/.test(t))).toBe(true);
    expect(texts.some((t) => /overdue/.test(t))).toBe(true);
  });

  it('drops a section whose source failed instead of showing a fake all-clear', () => {
    const b = composeBriefing(
      base({ unpaidInvoices: null, snapshot: null, emergencyCalls: null }),
      owner,
    );
    expect(b.sections.map((s) => s.key)).toEqual(['schedule', 'expiring', 'actions']);
  });

  it('technicians only see their own jobs and no billing anywhere', () => {
    const t: BriefingRecipient = {
      role: 'technician',
      name: null,
      canViewBilling: false,
      teamMemberId: 't1',
    };
    const b = composeBriefing(
      base({
        jobsToday: [
          job({ assigned_technician_id: 't1' }),
          job({ assigned_technician_id: 't2' }),
          job({ assigned_technician_id: null }),
        ],
        unpaidInvoices: [inv()],
      }),
      t,
    );
    expect(b.sections.map((s) => s.key)).toEqual(['schedule', 'emergencies']);
    expect(b.sections[0].items).toHaveLength(1);
    expect(b.sections[0].items[0].text).toMatch(/^1 job today/);
    expect(JSON.stringify(b)).not.toMatch(/overdue|\$/);
  });

  it('members without billing never get revenue rows or billing-flavoured AI actions', () => {
    const m: BriefingRecipient = {
      role: 'member',
      name: null,
      canViewBilling: false,
      teamMemberId: 'm1',
    };
    const raw: RawData = {
      ...emptyRaw,
      invoices: [
        {
          status: 'paid',
          sent_at: iso(1),
          paid_at: new Date(NOW - 3_600_000).toISOString(),
          created_at: iso(1),
          line_items: [{ quantity: 1, unit_price_cents: 500_000 }],
          tax_percent: 0,
        },
      ],
    };
    const b = composeBriefing(
      base({
        snapshot: computeSnapshot(raw, NOW),
        insights: [
          { title: 'Unsent invoices', recommended_action: 'Send the invoices now', priority: 5 },
          { title: 'Coverage', recommended_action: 'Add Friday coverage', priority: 3 },
        ],
      }),
      m,
    );
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/collected|Send the invoices/);
    expect(text).toMatch(/Add Friday coverage/);
  });

  it('shows only quotes expiring within 3 days and contracts within 30', () => {
    const b = composeBriefing(
      base({
        expiring: [
          { kind: 'quote', label: 'Q-1', date: '2026-10-13' },
          { kind: 'quote', label: 'Q-2', date: '2026-10-20' },
          { kind: 'contract', label: 'MSA', date: '2026-11-05' },
          { kind: 'contract', label: 'Old', date: '2026-12-31' },
        ],
      }),
      owner,
    );
    const texts = b.sections.find((s) => s.key === 'expiring')!.items.map((i) => i.text);
    expect(texts).toEqual(['Quote Q-1 expires tomorrow', 'Contract MSA expires in 24 days']);
  });
});

describe('rendering', () => {
  const b = composeBriefing(
    base({
      emergencyCalls: [
        { id: 'c1', caller_name: '<b>Zoe</b>', call_datetime: iso(10), has_job: false },
      ],
      insights: [{ title: 't', recommended_action: 'Call "back" <script>', priority: 5 }],
    }),
    owner,
  );
  it('push payload is short and links to the dashboard', () => {
    const p = toPushPayload(b);
    expect(p.body.length).toBeLessThanOrEqual(178);
    expect(p).toMatchObject({ url: '/dashboard', tag: 'daily-briefing' });
    expect(p.title).toMatch(/needs attention/);
  });
  it('email escapes untrusted text and collapses clear sections', () => {
    const e = toEmail(b, { companyName: 'Acme & Co', dashboardUrl: 'https://app.vireek.com' });
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<b>Zoe</b>');
    expect(e.html).toContain('Acme &amp; Co');
    expect(e.html).toContain('All clear:');
    expect(e.subject).toMatch(/^Daily briefing/);
  });
  it('plain text mirrors the briefing', () => {
    expect(toPlainText(b)).toMatch(/EMERGENCIES/);
    expect(toPlainText(b)).toMatch(/\(AI\)/);
  });
});
