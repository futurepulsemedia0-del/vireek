// src/lib/hiddenTech/demo.ts
//
// Deterministic demo data for the "Try with demo data" button and for tests. Nothing here touches the
// database: the demo is computed in the browser and clearly labelled as sample data.

import type { FixRecord, Snapshot } from './api';
import { analyzeLeaks, defaultHtSettings, type HtJob } from './leakEngine';
import { suggestFixes, type WaitlistEntry } from './fixes';

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;
export const DEMO_TECHS = [
  { id: 'demo-t1', name: 'Alex' }, { id: 'demo-t2', name: 'Jordan' }, { id: 'demo-t3', name: 'Sam' }, { id: 'demo-t4', name: 'Riley' },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function generateDemo(nowMs: number): { jobs: HtJob[]; waitlist: WaitlistEntry[] } {
  const rnd = rng(20271125);
  const today = Math.floor(nowMs / DAY) * DAY; // UTC midnight — the demo runs in UTC
  const jobs: HtJob[] = [];
  let n = 0;
  for (let offset = -26; offset <= 6; offset++) {
    const dayStart = today + offset * DAY;
    const dow = new Date(dayStart).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const future = offset >= 0;
    for (const tech of DEMO_TECHS) {
      let t = dayStart + 8 * HOUR;
      const count = future ? 2 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < count; i++) {
        const len = (45 + Math.floor(rnd() * 76)) * MIN;
        const gap = i === 0 ? 0 : (future ? 60 + Math.floor(rnd() * 120) : 10 + Math.floor(rnd() * 80)) * MIN;
        t += gap;
        const roll = rnd();
        const status = future ? 'scheduled' : roll < 0.06 ? 'no_show' : roll < 0.1 ? 'waiting_parts' : roll < 0.13 ? 'waiting_approval' : 'completed';
        jobs.push({
          id: `demo-j${++n}`, techId: tech.id, techName: tech.name,
          scheduledAt: new Date(t).toISOString(), startedAt: future ? null : new Date(t).toISOString(),
          completedAt: future ? null : new Date(t + len).toISOString(),
          enRouteAt: !future && i > 0 && rnd() < 0.7 ? new Date(t - (18 + Math.floor(rnd() * 12)) * MIN).toISOString() : null,
          durationMinutes: len / MIN, status, isRework: !future && rnd() < 0.05, tags: !future && rnd() < 0.08 ? 'parts' : null,
        });
        t += len;
      }
    }
  }
  const waitlist: WaitlistEntry[] = ['Maple Street Dental', 'R. Okafor', 'Linden Bakery', 'T. Brandt', 'Harbor Lofts', 'D. Alvarez'].map((customerName, i) => ({
    id: `demo-w${i + 1}`, customerName, serviceType: i % 2 ? 'Heat pump service' : 'AC repair', requestedDate: new Date(today + (i + 1) * DAY).toISOString().slice(0, 10),
    priority: i === 1 ? 5 : i % 3, createdAt: new Date(today - (10 - i) * DAY).toISOString(),
  }));
  return { jobs, waitlist };
}

/** A read-only Snapshot built entirely in memory. Approve/dismiss are disabled by the page in demo mode. */
export function buildDemoSnapshot(nowMs: number = Date.now()): Snapshot {
  const { jobs, waitlist } = generateDemo(nowMs);
  const settings = { ...defaultHtSettings('UTC') };
  const today = Math.floor(nowMs / DAY) * DAY;
  const actual = analyzeLeaks(jobs, { ...settings, includePlanned: false });
  const forecast = analyzeLeaks(jobs.filter((j) => Date.parse(j.scheduledAt ?? '') >= today), { ...settings, includePlanned: true });
  const fixes: FixRecord[] = suggestFixes({ forecast, history: actual, waitlist, nowMs, settings }).map((f, i) => ({
    ...f, id: `demo-fix-${i}`, status: 'suggested', recoveredHours: null, measureMethod: null, approvedAt: null, measuredAt: null, createdAt: new Date(nowMs).toISOString(),
  }));
  return { settings, actual, forecast, fixes, waitlistCount: waitlist.length, unassignedJobs: 0, recovered: { hours: 0, cost: 0 }, generatedAt: new Date(nowMs).toISOString() };
}
