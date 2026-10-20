// src/lib/hoursAuditSample.ts
//
// SYNTHETIC demo / fixture data for the Hours-Leak Audit. Every name, address and
// number below is generated — none of it is real customer or technician data.
// Deterministic (seeded) so tests and the "Try with sample data" button always agree.

export const SAMPLE_HEADERS = ['Technician', 'Job ID', 'Customer', 'Address', 'Start', 'End', 'Billable', 'Job Type'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (day: Date, minutes: number) => {
  const d = new Date(day.getTime() + minutes * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export interface SampleOptions {
  technicians?: number;
  days?: number;
  seed?: number;
  /** Adds a few deliberately broken rows (bad dates, missing technician, end before start, missing end). */
  malformed?: boolean;
}

/** Returns header + rows exactly as the file reader would (all cells are strings). */
export function buildSampleTable({ technicians = 6, days = 60, seed = 7, malformed = true }: SampleOptions = {}): { headers: string[]; rows: string[][] } {
  const rand = rng(seed);
  const types = ['Repair', 'Maintenance', 'Install', 'Estimate', 'Callback'];
  const rows: string[][] = [];
  let id = 1000;
  const first = Date.UTC(2026, 0, 5); // a Monday
  for (let t = 1; t <= technicians; t++) {
    const name = `Synthetic Tech ${String.fromCharCode(64 + t)}`;
    for (let d = 0; d < days; d++) {
      const day = new Date(first + d * 86_400_000);
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      let cursor = 7 * 60 + Math.floor(rand() * 45); // first job 07:00–07:45
      const jobs = 3 + Math.floor(rand() * 3);
      for (let j = 0; j < jobs; j++) {
        const len = 45 + Math.floor(rand() * 100);
        const type = types[Math.floor(rand() * types.length)];
        rows.push([
          name, `J-${id++}`, `SYNTHETIC Customer ${id}`, `${100 + Math.floor(rand() * 800)} Synthetic Street`,
          stamp(day, cursor), stamp(day, cursor + len), type === 'Callback' ? 'No' : 'Yes', type,
        ]);
        cursor += len + 15 + Math.floor(rand() * 75); // drive + idle gap
      }
    }
  }
  if (malformed && rows.length > 20) {
    rows[3][4] = 'not a date';
    rows[7][0] = '';
    rows[11][5] = rows[11][4]; // end == start
    rows[15][5] = ''; // missing end
    rows.push(['Synthetic Tech A', 'J-OVL-1', 'SYNTHETIC Customer X', '1 Synthetic Street', stamp(new Date(first), 8 * 60), stamp(new Date(first), 10 * 60), 'Yes', 'Repair']); // overlaps another job
  }
  return { headers: SAMPLE_HEADERS, rows };
}

export function buildSampleCsv(options?: SampleOptions): string {
  const { headers, rows } = buildSampleTable(options);
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, ...rows].map((r) => r.map(q).join(',')).join('\n');
}
